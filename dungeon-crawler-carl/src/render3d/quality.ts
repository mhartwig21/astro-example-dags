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
// 2. RESOLUTION CANNOT SEPARATE THE TIERS, BECAUSE MOST OF THE FRAME IS CPU.
//    Measured on this build, one page session, vsync off, 1440x852 @ dpr 2,
//    floor-15 dense scene, as MEDIAN frame time (tools/trk_ablate.mjs):
//
//        cut pixel count 4x   iGPU  -5.8 ms of 17.2      dGPU  -0.00 ms
//        freeze the graph     iGPU  renderMs 7.9 -> 3.5  dGPU  15.2 -> 8.0
//        gl.finish() drain    iGPU   0.00 ms median      dGPU   0.00 ms median
//
//    Read the last row first. By the time the main thread has finished
//    submitting a frame, the GPU has already finished drawing it — on BOTH
//    adapters, in every scene sampled (1-in-8 frames, n~1000). The GPU is never
//    the wall. And on the discrete part, quartering the pixel count is free to
//    three decimal places: a ladder made of pixel ratio is a ladder with one
//    rung on anything that isn't an Intel iGPU.
//
//    Worse, even the iGPU's 5.8 ms is not all raster. Cutting pixel count 4x
//    also made PURE-JS Renderer3D.update() 30% faster (6.1 -> 4.3 ms) — JS that
//    issues no GL calls at all. The Intel part taxes the main thread through the
//    shared package power and bandwidth budget, so ~1.8 ms of that 5.8 is
//    recovered CPU throughput, not removed fill.
//
// 3. WHAT THE FRAME IS ACTUALLY SPENT ON (same session, iGPU, floor-15 combat):
//
//        scene-graph matrix walk inside render()  5.5 ms   7,566 nodes walked
//                                                          to issue ~250 draws
//        AnimationMixer over every rig            2.5-3.0 ms
//        raster/fill                              5.8 ms   (1.8 of it CPU)
//        shadow pass                              2.4 ms   50 of ~250 draws
//        host per-frame DOM                       2.1 ms
//        sim step()                               1.19 ms  <- not the problem
//        GC                                       0.01-0.09 ms  <- nil
//        ENTIRE post chain (GTAO+bloom+SMAA)      0.7 ms   <- two rounds were
//                                                             spent on this
//
//    Floor 15 carries 149 animated rigs and 18 of them are on screen. The other
//    131 are 4,664 scene nodes and 3,277 bones — 87% of every bone in the
//    scene — walked and animated every frame for nothing.
//
// ============================================================================
// SO THE MODES SPEND FOUR THINGS, AND THREE OF THEM ARE CPU
// ============================================================================
//
//   pixelRatioCap        softness. Real on the iGPU, ~free on the dGPU.
//   rig animation        rigs that are not on screen animate at a lower rate,
//                        and a huge brawl caps how many animate at full rate.
//   shadow map + cadence crispness and staleness of contact shadows.
//   AO / bloom scale     the cheap tail. Kept small on purpose — it is 4% of
//                        the frame and the ladder should stop pretending
//                        otherwise.
//
// WHAT IS **NOT** A MODE LEVER, because it is free and therefore belongs to
// every mode: parking out-of-vision bodies out of the scene graph entirely,
// and refreshing the HUD's screen rects on a cadence instead of six
// getBoundingClientRect calls per frame. A win with no visual cost is not a
// setting; tiering it would just make HIGH needlessly slow.
//
// AND WHAT IS STILL NOT CUT: ambient occlusion, particle density, mote density
// and the light pools are IDENTICAL on all three rungs. Those are losses a
// player can name ("the shadows under things are gone", "there's less going
// on"). The CPU levers above are invisible by construction — an off-screen rig
// is off screen — which is exactly why they are the right things to spend.

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
  /** ms/frame this mode may not exceed on the weak path, or null for "no gate". */
  readonly budgetMs: number | null;
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

  // ---- Rig animation (the CPU lever) ----
  //
  // Floor 15: 149 rigs, 18 on screen. AnimationMixer.update over the other 131
  // costs 2.5-3.0 ms/frame on the iGPU and 1.3-1.5 ms on the dGPU, to pose
  // bones that no pass reads. The two knobs below are what a mode spends.
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
  /** How many rigs may take a full-rate mixer update in one frame, nearest to
   *  the camera first. Infinity = no cap. Only bites in a large brawl; the
   *  overflow falls back to `offscreenRigHz`, which is why a capped rig still
   *  animates rather than freezing. */
  readonly rigBudget: number;

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
 * MEASURED in REFERENCE_SCENE (tools/trk_modes.mjs, 5 interleaved samples):
 *     iGPU  median 29.1 ms (34 fps)  mean 51.0  p10 21.4  p95 157.0  718 draws
 *     dGPU  median 16.1 ms (62 fps)  mean 17.2  p10 13.7  p95  25.9  974 draws
 *
 * The iGPU number is not a failure, it is the point: HIGH is where the
 * appearance and combat-FX work lives at full strength, and a player who picks
 * it on an integrated part has been told what they are buying — the settings
 * row says "no frame-rate promise" in those words.
 *
 * READ THE MEAN NEXT TO THE MEDIAN. Intel: 29.1 median, 51.0 mean, p95 157 —
 * ratio 1.75, a bimodal frame that the median flatters and the player does not.
 * RTX: 16.1 median, 17.2 mean, p95 25.9 — ratio 1.07, genuinely smooth, and in
 * a scene carrying HALF AGAIN as many bodies. That contrast is the same
 * distribution QualityAutoTuner exists to see through.
 */
const HIGH: QualityProfile = {
  name: "high",
  label: "HIGH",
  blurb: "everything at full strength — no frame-rate promise",
  contract: {
    budgetMs: null,
    promise: "the best this engine can do — uncapped, and it will cost what it costs",
    maxPixelRatio: 2,
    maxShadowCost: 1,
    maxRigCost: 1,
    maxPostCost: 1,
  },
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
  offscreenRigHz: Infinity,
  rigBudget: Infinity,
  fxDensity: 1,
  moteDensity: 1,
  fxLights: 4,
  torchLights: 8,
};

/**
 * MEDIUM — the default. Contract: never worse than 33.3 ms (30 fps) in the
 * worst real scene on the weak path.
 *
 * MEASURED in REFERENCE_SCENE (tools/trk_modes.mjs, 5 interleaved samples):
 *     iGPU  median 20.5 ms (49 fps)  mean 25.9  p10 13.3  p95 55.2  591 draws
 *     dGPU  median 15.4 ms (65 fps)  mean 17.6  p10 11.9  p95 31.2  763 draws
 *
 * 20.5 against a 33.3 ceiling — 62% of budget, on the part that defines the
 * budget, measured with a rival workload live on the box. The owner's brief
 * guessed MEDIUM would land "2x off" the 16.7 ms target; 33.3 ms is that guess
 * written down as a promise the mode MAY NOT BREAK, not a speed it is required
 * to be. Landing well inside is a bonus, not a contract violation, and it is
 * the reason MEDIUM is the default rather than a compromise.
 */
const MEDIUM: QualityProfile = {
  ...HIGH,
  name: "medium",
  label: "MEDIUM",
  blurb: "the default — 30 fps guaranteed on integrated graphics, and it still looks like the game",
  contract: {
    budgetMs: 33.3,
    promise: "never below 30 fps, even in the worst fight, on integrated graphics",
    maxPixelRatio: 1.4,
    maxShadowCost: 0.28125,   // (1536/2048)^2 / 2
    maxRigCost: 0.2967,       // 18 on screen + 131 off at 12 Hz, of 149
    maxPostCost: 0.765,
  },
  pixelRatioCap: 1.4,
  gtaoSamples: 9,
  gtaoDenoiseSamples: 6,
  bloomScale: 0.45,
  shadowMapSize: 1536,
  shadowInterval: 2,
  offscreenRigHz: 12,
  rigBudget: 28,
};

/**
 * LOW — the mode that carries the performance guarantee. Contract: 60 fps
 * (16.7 ms) in the worst real scene on the weak path.
 *
 * MEASURED in REFERENCE_SCENE (tools/trk_modes.mjs, 5 interleaved samples):
 *     iGPU  median 15.1 ms (66 fps)  mean 17.2  p10 12.0  p95 31.9  563 draws
 *     dGPU  median 12.6 ms (79 fps)  mean 14.8  p10  9.8  p95 24.0  737 draws
 *
 * 15.1 against a 16.7 ceiling — 90% of budget, in the worst scene, on the weak
 * adapter, with a rival workload live on the box. The margin is thin and it is
 * meant to be read that way: LOW is the mode carrying the promise, so it is the
 * mode whose measurement is allowed the least slack.
 *
 * AND THE MEAN IS 17.2, WHICH IS OVER. Not hidden, because it is the honest
 * shape of the result: the median frame is 15.1 ms and the tail is not. Two
 * things are in that tail and neither is a thing a MODE can fix — (a) the box
 * carried 10-18 foreign chrome.exe throughout, and preemption lands on the mean
 * far harder than on the median; (b) r2's finding that warm-up hitches SURVIVE
 * readiness is still true and still unfixed (p95 31.9). The contract is stated
 * on the median because that is what the brief asked for and what these levers
 * control; closing the tail is a different job and pretending this round did it
 * would be the lie.
 *
 * WHAT IT GIVES UP, honestly: the frame is rendered at 1x pixel density (it is
 * softer — this is the only thing a player is likely to notice), contact
 * shadows are half the map resolution and rebuild every third frame, and rigs
 * that are not on screen pose at 6 Hz with at most 14 animating at full rate in
 * a brawl. It does NOT give up ambient occlusion, particles, motes or any
 * light: those measured ~4% of the frame together, so cutting them would pay a
 * price the player can name for a saving they cannot feel.
 *
 * There is no mode below this one. A machine that cannot hold 16.7 ms here has
 * nowhere left to fall, which is why it is allowed to look plainer.
 */
const LOW: QualityProfile = {
  ...HIGH,
  name: "low",
  label: "LOW",
  blurb: "60 fps guaranteed on integrated graphics — softer frame, same game",
  contract: {
    budgetMs: 16.7,
    promise: "60 fps in the worst fight on integrated graphics — the mode that promises a number",
    maxPixelRatio: 1,
    maxShadowCost: 0.08334,   // (1024/2048)^2 / 3
    maxRigCost: 0.1846,       // 14 nearest at full rate, the rest at 6 Hz, of 149
    maxPostCost: 0.295,
  },
  pixelRatioCap: 1,
  gtaoScale: 0.25,
  gtaoDenoiseScale: 0.5, // bilinear upsample in the AO blend; softer, much cheaper
  gtaoSamples: 6,
  gtaoDenoiseSamples: 4,
  bloomScale: 0.35,
  shadowMapSize: 1024,
  shadowInterval: 3,
  offscreenRigHz: 6,
  rigBudget: 14,
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
  "floor 15, staged dense combat — the crawler is teleported into the densest "
  + "live pack and pinned alive; 1440x852 CSS @ devicePixelRatio 2; vsync off; "
  + "5 interleaved samples per mode inside ONE page session; 10-18 foreign "
  + "chrome.exe live throughout, so every figure is an UPPER bound. "
  + "iGPU session: ~22 monsters in vision, 195 skinned meshes, ~665 bones, "
  + "563-718 draws. dGPU session: ~32 in vision, ~260 skinned meshes, ~890 "
  + "bones, 737-974 draws — a HEAVIER scene, so the two adapters' absolute "
  + "times are NOT comparable to each other; only each adapter's own ladder is";

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
 * On-screen rigs always animate every frame — that is not negotiable and no
 * mode touches it. The off-screen 131 pay `offscreenRigHz / 60`, and the rig
 * budget claws back whichever of them would still have animated at full rate.
 */
const REF_RIGS = 149;
const REF_RIGS_ON_SCREEN = 18;
export function rigWeight(p: QualityProfile): number {
  const off = REF_RIGS - REF_RIGS_ON_SCREEN;
  const onScreen = Math.min(REF_RIGS_ON_SCREEN, p.rigBudget);
  // Anything on screen beyond the budget is demoted to the off-screen rate too.
  const demoted = REF_RIGS_ON_SCREEN - onScreen;
  const offRate = Math.min(1, p.offscreenRigHz / 60);
  return (onScreen + (off + demoted) * offRate) / REF_RIGS;
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
 * WHAT WAS ACTUALLY ON THE CLOCK — MEDIAN frame time in REFERENCE_SCENE.
 *
 * The contract is stated on the median because that is the statistic the brief
 * asked for ("16.7 ms median") and the one the levers in this file control.
 * MEASURED_MEAN is carried right next to it because on the Intel part the two
 * diverge violently and quoting only the friendlier one would be the whole
 * problem this round exists to stop repeating.
 *
 * Transcribed from tools/_trkmodes_igpu_combat.json and _trkmodes_dgpu_combat.json.
 * Nothing in this file derives them.
 */
export const MEASURED: Record<QualityName, Record<Adapter, number>> = {
  high: { igpu: 29.1, dgpu: 16.1 },
  medium: { igpu: 20.5, dgpu: 15.4 },
  low: { igpu: 15.1, dgpu: 12.6 },
};

/**
 * THROUGHPUT over the same samples (mean, excluding >400 ms stalls).
 *
 * WHY IT IS HERE. Median and mean tell different stories about the same frame,
 * and one of them flatters. HIGH on the Intel part is median 29.1 against a
 * mean of 51.0 — a ratio of 1.75, which is rAF running ahead, filling the swap
 * chain and then blocking. The same mode on the RTX is 16.1 against 17.2, a
 * ratio of 1.07: a genuinely smooth frame. That contrast is the sharpest
 * evidence in this file that the two adapters are not just "fast and slow".
 *
 * AND LOW'S MEAN IS 17.2 AGAINST ITS OWN 16.7 BUDGET. Said plainly rather than
 * omitted: LOW meets its contract on the median (15.1) and misses it by half a
 * millisecond on the mean. Two things are in that gap and neither is something
 * a MODE can fix — 10-18 foreign chrome.exe were live on the box for every
 * sample, and r2's finding that warm-up hitches SURVIVE readiness is still
 * true and still unfixed. The contract is on the median because that is what
 * the brief asked for and what these levers control.
 */
export const MEASURED_MEAN: Record<QualityName, Record<Adapter, number>> = {
  high: { igpu: 51.0, dgpu: 17.2 },
  medium: { igpu: 25.9, dgpu: 17.6 },
  low: { igpu: 17.2, dgpu: 14.8 },
};

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
