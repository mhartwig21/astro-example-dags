// PERFORMANCE MODES — three rungs, each with a contract it was measured against.
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
 * ITS PROMISE WAS FALSE AND HAS BEEN REWRITTEN. The shipped line was "never
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
 * IT USED TO PROMISE 60 fps AND IT NEVER DELIVERED 60 fps. The old contract was
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
  blurb: "the performance mode — softest frame, same game, nothing on screen is cut",
  contract: {
    budgetMs: 20,
    maxOverPct: 10,
    promise: "the smoothest this engine gets — aims to stay above 50 fps on integrated graphics",
    maxPixelRatio: 1,
    maxShadowCost: 0.08334,   // (1024/2048)^2 / 3
    maxRigCost: 0.2088,       // 18 on screen at full rate + 131 off at 6 Hz, of 149
    maxPostCost: 0.27,
  },
  pixelRatioCap: 1,
  gtaoScale: 0.25,
  gtaoDenoiseScale: 0.25,
  gtaoSamples: 6,
  gtaoDenoiseSamples: 4,
  bloomScale: 0.35,
  shadowMapSize: 1024,
  shadowInterval: 3,
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

/**
 * The scene every number in this file was measured in. Staged by MEASURED
 * DENSITY rather than a key-press recipe, because an earlier version of the
 * harness stumbled into an empty room (and then into a death screen) and called
 * the result heavy combat — see tools/trk_modes.mjs.
 */
export const REFERENCE_SCENE =
  "floor 15, staged dense combat (tools/r2_modes.mjs) — the crawler is "
  + "teleported into the densest live pack and pinned alive, and RE-STAGED "
  + "between every window so a thinning pack cannot charge the later modes for "
  + "a lighter scene; 1440x852 CSS @ devicePixelRatio 2; vsync off; 3 reps with "
  + "the mode order ROTATED inside each rep, all inside ONE page session; "
  + "24-39 monsters in vision; ~1,600 scene nodes. Every window is gated at "
  + "BOTH ends on a GPU-contention canary (the post chain over an empty scene: "
  + "3.8-9.5 ms quiet, 27-80 ms contended) and discarded if either end fails, "
  + "because on a shared-memory Intel part a rival browser's GPU work is "
  + "invisible to a process count. 10-21 foreign chrome.exe were live on the "
  + "box throughout, so every figure is still an UPPER bound. The two adapters "
  + "ran separate sessions with separately staged packs, so their absolute "
  + "times are NOT comparable to each other; only each adapter's own ladder is. "
  + "MEASURED_QUIET is the same session shape with the crawler walked to the "
  + "farthest point from any live monster";

/** CSS-pixel area of the reference viewport, in megapixels at ratio 1. */
const REFERENCE_CSS_MPX = (1440 * 852) / 1e6;

/** Backbuffer megapixels this preset asks for, in the reference viewport. */
export function referenceMegapixels(p: QualityProfile): number {
  const ratio = Math.min(2, p.pixelRatioCap); // the reference display is dpr 2
  return REFERENCE_CSS_MPX * ratio * ratio;
}

/**
 * Fraction of the shadow pass a preset still pays. Area scales with the map
 * edge squared; cadence divides the draw calls. Both were measured to be very
 * nearly linear over the range the presets use.
 */
export function shadowWeight(p: QualityProfile): number {
  if (p.shadowMapSize <= 0) return 0;
  const area = (p.shadowMapSize / 2048) ** 2;
  return area / Math.max(1, p.shadowInterval);
}

/**
 * Fraction of the full-rate mixer cost a preset still pays, in the reference
 * scene: 149 rigs, 18 of them on screen.
 *
 * ON-SCREEN RIGS ALWAYS ANIMATE EVERY FRAME. That sentence stood here before
 * opt r2 as well — and it was false, because `rigBudget` demoted the on-screen
 * overflow and this function modelled it doing so. Now there is no overflow
 * term: the whole on-screen 18 are charged at full rate in every mode, and the
 * only thing a preset spends is the rate the off-screen 131 are sampled at.
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
 * WHY IT IS A RECORD AND NOT A NUMBER. The table this replaces was a single
 * median per mode per adapter, and the acceptance pass's verdict on it is the
 * reason this type exists: "it cannot express p90, p99 or the share of frames
 * over budget, so the contract it justifies is not auditable from the artefact
 * that justifies it." A ladder that ships one statistic can only ever be
 * checked against that statistic, and the one it shipped was the flattering one.
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
  /** % of individual frames over 33.3 ms. What `maxOverPct` is checked against. */
  readonly over33: number;
}

/**
 * WHAT WAS ACTUALLY ON THE CLOCK IN THE WORST SCENE — the floor-15 dense pack.
 *
 * Transcribed from tools/_r2modes_after_igpu_dense.json and
 * _r2modes_after_dgpu_dense.json. Nothing in this file derives them.
 *
 * THE HARNESS EARNS THE NUMBERS AND IS PART OF THE CLAIM (tools/r2_modes.mjs):
 * mode order rotates inside every rep, the pack is re-staged between every
 * window, the raw frame deltas survive to the end, a window whose preset
 * fingerprint moved is refused outright, and — the one that mattered most on
 * this box — every window is gated at BOTH ends on a GPU-contention canary.
 *
 * THE CANARY IS NOT OPTIONAL AND THE REASON IS IN THIS TABLE'S HISTORY. On a
 * shared-memory Intel part a rival browser's GPU work is invisible to a process
 * count: one attempt at this exact ladder returned LOW at 4.4 fps and HIGH at
 * 2.4 fps with the foreign chrome.exe count unchanged, and the previous round
 * threw away a whole session at 2.0-3.3 fps for the same reason. The canary
 * renders the post chain over an EMPTY scene — nearly no CPU in it — and reads
 * 3.8-9.5 ms on a quiet Intel part against 27-80 ms on a contended one. Windows
 * taken above the ceiling are discarded and retried, not averaged in.
 *
 * READ `delivered` AGAINST `p50` FIRST. Where they agree the frame is genuinely
 * paced; where `delivered` is a multiple of `p50` the swap chain is queueing
 * cheap callbacks in front of expensive ones and the median is describing the
 * queue rather than the machine. On the Intel part at HIGH that ratio is 1.36;
 * on the RTX it is 1.09. The old single-median table could not contain that.
 */
export const MEASURED: Record<QualityName, Record<Adapter, MeasuredShape>> = {
  high: {
    igpu: { fps: 19.56, delivered: 51.13, p50: 37.5, p90: 118.4, p99: 239.4, over33: 50.7 },
    dgpu: { fps: 78.44, delivered: 12.75, p50: 11.7, p90: 16.9, p99: 27.3, over33: 0.3 },
  },
  medium: {
    igpu: { fps: 41.24, delivered: 24.25, p50: 14.2, p90: 54.3, p99: 132.3, over33: 19.3 },
    dgpu: { fps: 91.52, delivered: 10.93, p50: 9.8, p90: 16.7, p99: 24.8, over33: 0 },
  },
  low: {
    igpu: { fps: 64.12, delivered: 15.60, p50: 12.3, p90: 24.2, p99: 58.3, over33: 5.8 },
    dgpu: { fps: 92.50, delivered: 10.81, p50: 9.6, p90: 16.6, p99: 23.7, over33: 0 },
  },
};

/**
 * THE SAME MODES IN A QUIET ROOM, on the weak path — the scene the previous
 * round never measured and the acceptance pass broke MEDIUM's promise in.
 *
 * "Worst scene" was always assumed to mean "densest pack", and that is not
 * obviously true: a quiet room has fewer bodies but the same backbuffer, the
 * same post chain and the same shader-build exposure, and on a fill-bound
 * adapter that is most of the frame. Measured against the SHIPPED build it was
 * worse than the dense pack — MEDIUM spent 17.2% of its frames over 33.3 ms
 * with nothing on screen, p90 57.4 ms, p99 188.4 ms.
 *
 * It is not worse any more, and it is measured now rather than assumed:
 *
 *     MEDIUM, quiet room, Intel   before  17.2% over 33.3, p90 57.4, p99 188.4
 *                                 after    5.0% over 33.3, p90  8.2, p99 163.7
 *     HIGH,   quiet room, Intel   before  30.4% over 33.3,           p99 393.6
 *                                 after    5.9% over 33.3, p90 10.4, p99 609.2
 *
 * (The "before" row is the acceptance pass's own measurement of the shipped
 * build, not this harness's, so the two are not the same instrument. The
 * "after" rows are from tools/_r2modes_after_igpu_empty.json, canary 3.8 ms.)
 *
 * WEAK PATH ONLY, DELIBERATELY. The quiet room exists in this file because it
 * is where a promise made to integrated graphics was found broken. Carrying a
 * discrete-GPU column would be carrying three numbers that no contract reads.
 */
export const MEASURED_QUIET: Record<QualityName, MeasuredShape> = {
  high: { fps: 36.20, delivered: 27.63, p50: 4.3, p90: 10.4, p99: 609.2, over33: 5.9 },
  medium: { fps: 79.00, delivered: 12.66, p50: 2.3, p90: 8.2, p99: 163.7, over33: 5.0 },
  low: { fps: 204.48, delivered: 4.89, p50: 2.4, p90: 9.8, p99: 38.8, over33: 2.5 },
};

/**
 * WHAT EACH OF THIS ROUND'S CHANGES IS WORTH — as the DELIVERED-TIME RATIO you
 * get by REVERTING it, measured inside one page session against a baseline
 * window on either side of it (tools/r2_which.mjs).
 *
 * WHY NOT A BEFORE TABLE AND AN AFTER TABLE. That is what this round tried
 * first, and it produced a false alarm big enough to have sent the whole thing
 * in the wrong direction: the AFTER ladder on the RTX read HIGH at 78.4 fps
 * against a BEFORE of 92.4 and looked like a 15% regression. It was not. The
 * BEFORE session had run with 10 foreign chrome.exe on the box and the AFTER
 * with 21, and the same change A/B'd INSIDE one session came out a 9.2% WIN.
 * Cross-session absolutes are not comparable on this machine, at all, and any
 * conclusion drawn from a pair of them is a conclusion about the neighbours.
 *
 * So the regression gate is the ratio, not the pair. A value above 1.0 means
 * "putting the old behaviour back makes the frame that much slower", i.e. the
 * change is a win of (ratio - 1).
 */
export const AB_REVERT: Record<string, Record<Adapter, number>> = {
  /**
   * Put the AO denoise back to full resolution over a half-res AO buffer (the
   * r4 arrangement). THE HEADLINE OF THE ROUND: 31.5% of the frame on the
   * adapter the promises are made to, and it is not a quality cut — the
   * filtering still happens, at the resolution the data actually has.
   */
  aoFullDenoise: { igpu: 1.315, dgpu: 1.092 },
  /**
   * Turn the late-program catcher off. It is a small NET COST in throughput on
   * the Intel part (~2% after the key memoization; 4.3% before it) and free on
   * the RTX — and it is kept anyway, because what it buys is not throughput.
   * The shipped build's own [shader-guard] fired 2.7-2.8 times per minute of
   * ordinary floor-15 play AFTER full readiness, each one a synchronous program
   * build worth several hundred milliseconds. Across 4.1 minutes of measured
   * play after the change it fired zero times. A ratio below 1.0 here is the
   * price of that, stated rather than hidden.
   */
  lateProgramCatcher: { igpu: 0.978, dgpu: 1.005 },
};

/**
 * [shader-guard] fires per minute of ordinary floor-15 play, AFTER full
 * readiness (assets settled, #loading gone and boxless, plus three seconds).
 * Each fire is one synchronous GLSL->HLSL->D3D build on the frame a material is
 * first drawn, and they are the 393-2078 ms p99 that no quality mode removes.
 */
export const SHADER_BUILDS_PER_MIN = { before: 2.75, after: 0 };

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
 * IT NEVER GUESSES HIGH. The four-rung ladder started an unknown machine at its
 * TOP rung and let the tuner descend, on the argument that guessing low ships a
 * permanently softer frame to hardware that never needed it. That argument does
 * not survive the re-cut: HIGH is now explicitly the mode with NO frame-rate
 * promise, so booting an unidentified machine into it means the default
 * experience is an unbounded frame time chosen on the player's behalf. MEDIUM
 * is the mode that promises 30 fps and looks like the game, so MEDIUM is where
 * an unknown machine starts, and the tuner climbs to HIGH from there if the
 * machine demonstrates the headroom. Guessing costs at most a few seconds of
 * being one rung conservative; guessing wrong the other way costs a stutter the
 * player never opted into.
 *
 * The one place the guess still goes DOWN on sight is a phone.
 */
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
