import { describe, expect, it } from "vitest";
import {
  MEASURED, MEASURED_MEAN, QUALITY_ORDER, QUALITY_PRESETS, QualityAutoTuner, guessQuality,
  postWeight, referenceMegapixels, rigWeight, shadowWeight, type Adapter, type QualityName,
} from "../src/render3d/quality";
import { deviceClass } from "../src/input/touchLayout";

const ADAPTERS: Adapter[] = ["igpu", "dgpu"];

/** Feed the tuner `seconds` of frames at a steady frame time. */
function run(t: QualityAutoTuner, frameMs: number, seconds: number): QualityName[] {
  const changes: QualityName[] = [];
  const frames = Math.round((seconds * 1000) / frameMs);
  for (let i = 0; i < frames; i++) {
    const next = t.sample(frameMs);
    if (next) changes.push(next);
  }
  return changes;
}

// ===========================================================================
// THE CONTRACTS. This block is the reason the file exists.
//
// Three modes were shipped with three promises, and a promise nothing checks is
// a comment. These tests fail if a mode's preset definition stops buying what
// the mode's contract says it buys — which is exactly what happens when someone
// raises LOW's pixel ratio "just a bit" or gives it back a full-rate mixer.
// ===========================================================================
describe("performance modes: the declared contract must be met by the preset", () => {
  it("LOW promises 60 fps and MEDIUM promises 30 — on the weak path, in the worst scene", () => {
    // The promises themselves, pinned so a rewrite of the ladder cannot quietly
    // relax them. LOW is the mode that carries the guarantee; HIGH deliberately
    // carries none.
    expect(QUALITY_PRESETS.low.contract.budgetMs).toBe(16.7);
    expect(QUALITY_PRESETS.medium.contract.budgetMs).toBe(33.3);
    expect(QUALITY_PRESETS.high.contract.budgetMs).toBeNull();
  });

  // (1) WHAT WAS ON THE CLOCK. The direct reading of the contract: the number
  //     actually measured on the weak path must be inside the declared budget.
  it("the MEASURED weak-path frame time is inside every declared budget", () => {
    for (const name of QUALITY_ORDER) {
      const budget = QUALITY_PRESETS[name].contract.budgetMs;
      if (budget === null) continue;
      expect.soft(MEASURED[name].igpu, `${name} measured on the Intel part`)
        .toBeLessThanOrEqual(budget);
    }
  });

  // (2) WHAT THE PRESET BUYS. (1) is a fact about one build at one moment and
  //     it does not move when the preset does — raise LOW's pixel ratio and the
  //     transcribed 11.2 sits there lying. THIS is the check that survives an
  //     edit: the preset's own lever values must still be the ones the
  //     measurement was taken at.
  //
  //     A tolerance is allowed only for float representation, NOT for drift.
  //     The intended way to change a lever is to change it, re-measure, and
  //     move the cap and the number together in the same commit.
  it("every preset still sits at the lever values its budget was measured at", () => {
    for (const name of QUALITY_ORDER) {
      const p = QUALITY_PRESETS[name];
      const c = p.contract;
      expect.soft(p.pixelRatioCap, `${name} pixel ratio`).toBeLessThanOrEqual(c.maxPixelRatio);
      expect.soft(shadowWeight(p), `${name} shadow cost`).toBeLessThanOrEqual(c.maxShadowCost + 1e-4);
      expect.soft(rigWeight(p), `${name} rig cost`).toBeLessThanOrEqual(c.maxRigCost + 1e-4);
      expect.soft(postWeight(p), `${name} post cost`).toBeLessThanOrEqual(c.maxPostCost + 1e-4);
    }
  });

  // THE FALSIFICATION TEST. If the caps were slack, the check above would pass
  // vacuously — so each lever is nudged the wrong way and must break its own
  // cap. This is what stops "maxRigCost: 1" being quietly pasted onto LOW.
  it("the lever caps are tight — loosening any lever breaks its own cap", () => {
    const low = QUALITY_PRESETS.low;
    const c = low.contract;
    expect(shadowWeight({ ...low, shadowInterval: 1 }), "shadow cadence")
      .toBeGreaterThan(c.maxShadowCost);
    expect(shadowWeight({ ...low, shadowMapSize: 2048 }), "shadow map size")
      .toBeGreaterThan(c.maxShadowCost);
    expect(rigWeight({ ...low, offscreenRigHz: 30 }), "off-screen rig rate")
      .toBeGreaterThan(c.maxRigCost);
    expect(rigWeight({ ...low, rigBudget: 40 }), "rig budget")
      .toBeGreaterThan(c.maxRigCost);
    expect(postWeight({ ...low, gtaoSamples: 12 }), "AO samples")
      .toBeGreaterThan(c.maxPostCost);
    expect(postWeight({ ...low, bloomScale: 0.5 }), "bloom scale")
      .toBeGreaterThan(c.maxPostCost);
  });

  it("each mode really did measure faster than the one above it, on BOTH adapters", () => {
    for (const a of ADAPTERS) {
      for (let i = 1; i < QUALITY_ORDER.length; i++) {
        expect.soft(MEASURED[QUALITY_ORDER[i]][a], `measured ${QUALITY_ORDER[i]} on ${a}`)
          .toBeLessThan(MEASURED[QUALITY_ORDER[i - 1]][a]);
      }
    }
  });

  // THE FINDING THE WHOLE RE-CUT IS BUILT ON, pinned so it cannot be forgotten
  // again: the four-rung ladder spent resolution and only resolution, and on
  // the discrete part that buys very little. Across the whole ladder HIGH
  // renders 4x the pixels of LOW and costs 3.5 ms more on the RTX against
  // 14.0 ms more on the Intel part — and the RTX session was carrying HALF
  // AGAIN as many bodies while doing it.
  it("the ladder barely exists on the discrete GPU — which is why resolution cannot be the only lever", () => {
    const dSpread = MEASURED.high.dgpu - MEASURED.low.dgpu;
    const iSpread = MEASURED.high.igpu - MEASURED.low.igpu;
    expect(dSpread).toBeLessThan(6);
    expect(iSpread).toBeGreaterThan(2.5 * dSpread);
  });

  // THE MEAN IS CARRIED NEXT TO THE MEDIAN ON PURPOSE, and the specific claim
  // is narrower than "the Intel part is slower": it is that the Intel frame at
  // HIGH goes BIMODAL, where rAF queues cheap frames and then blocks. Measured
  // mean/median ratios — Intel HIGH 1.75 (p95 157 ms), RTX HIGH 1.07 (p95
  // 25.9 ms). Quoting only the friendlier statistic is the failure this track
  // keeps rediscovering, so the mean lives in code and has to stay worse.
  it("the Intel frame at HIGH is bimodal and the discrete one is not", () => {
    const ratio = (n: QualityName, a: Adapter) => MEASURED_MEAN[n][a] / MEASURED[n][a];
    expect(ratio("high", "igpu")).toBeGreaterThan(1.5);
    expect(ratio("high", "dgpu")).toBeLessThan(1.15);
    // Every mode's throughput is worse than its median somewhere — a table
    // where the mean never costs anything would mean it was never measured.
    for (const name of QUALITY_ORDER) {
      expect.soft(MEASURED_MEAN[name].igpu, `${name} iGPU mean vs median`)
        .toBeGreaterThan(MEASURED[name].igpu);
    }
  });

  // LOW MISSES ITS OWN BUDGET ON THE MEAN. Asserted, not glossed: if a later
  // round closes the warm-up tail this test starts failing, which is exactly
  // when someone should come back and re-state the contract on throughput.
  it("records that LOW meets its budget on the median and not on the mean", () => {
    expect(MEASURED.low.igpu).toBeLessThanOrEqual(QUALITY_PRESETS.low.contract.budgetMs!);
    expect(MEASURED_MEAN.low.igpu).toBeGreaterThan(QUALITY_PRESETS.low.contract.budgetMs!);
  });
});

describe("performance modes: the levers", () => {
  it("every mode is cheaper than the one above it on the levers that matter", () => {
    for (let i = 1; i < QUALITY_ORDER.length; i++) {
      const hi = QUALITY_PRESETS[QUALITY_ORDER[i - 1]];
      const lo = QUALITY_PRESETS[QUALITY_ORDER[i]];
      expect(lo.pixelRatioCap, `${lo.name} pixel ratio`).toBeLessThanOrEqual(hi.pixelRatioCap);
      expect(lo.shadowMapSize, `${lo.name} shadow map`).toBeLessThanOrEqual(hi.shadowMapSize);
      expect(lo.shadowInterval, `${lo.name} shadow cadence`).toBeGreaterThanOrEqual(hi.shadowInterval);
      expect(lo.bloomScale, `${lo.name} bloom scale`).toBeLessThanOrEqual(hi.bloomScale);
      expect(lo.fxDensity, `${lo.name} fx density`).toBeLessThanOrEqual(hi.fxDensity);
      // The CPU levers the four-rung ladder never had.
      expect(lo.offscreenRigHz, `${lo.name} off-screen rig rate`).toBeLessThanOrEqual(hi.offscreenRigHz);
      expect(lo.rigBudget, `${lo.name} rig budget`).toBeLessThanOrEqual(hi.rigBudget);
    }
  });

  // THE FINDING THIS FILE ORIGINALLY EXISTED FOR: a 4x MSAA HalfFloat composer
  // target cost ~85% of the frame on the target iGPU. No mode may quietly
  // reintroduce it.
  it("no mode ships a multisampled HDR composer target", () => {
    for (const name of QUALITY_ORDER) {
      expect(QUALITY_PRESETS[name].msaaSamples, `${name} MSAA`).toBe(0);
      expect(QUALITY_PRESETS[name].smaa, `${name} needs SMAA to replace it`).toBe(true);
    }
  });

  it("HIGH is the reference look: full pixel ratio, every effect on, no gates", () => {
    const u = QUALITY_PRESETS.high;
    expect(u.pixelRatioCap).toBe(2);
    expect(u.gtao).toBe(true);
    expect(u.bloom).toBe(true);
    expect(u.fxDensity).toBe(1);
    // Half-res AO is only free-of-quality-cost because the denoise pass runs at
    // full resolution and doubles as a depth-weighted bilateral upsample.
    expect(u.gtaoScale).toBeLessThan(1);
    expect(u.gtaoDenoiseScale).toBe(1);
    // HIGH is where the appearance work lives at full strength: no rig is ever
    // gated, no matter how big the brawl.
    expect(u.offscreenRigHz).toBe(Infinity);
    expect(u.rigBudget).toBe(Infinity);
  });

  // NO MODE CUTS CONTENT.
  //
  // An earlier bottom rung set gtao:false, fxDensity 0.6, moteDensity 0.5,
  // torchLights 5 — losses a player can NAME ("the shadows under things are
  // gone", "there's less going on"). That was retracted once, and the re-cut to
  // three modes did not bring it back: measurement says ambient occlusion,
  // particles and motes together are ~4% of the frame, so cutting them pays a
  // visible price for nothing. The levers the modes DO spend (pixel ratio, rig
  // animation rate, shadow cadence) are softness and off-screen work, not
  // content. Anything that reintroduces a content cut should fail here and be
  // argued for on purpose.
  it("no mode cuts content — occlusion, particles, motes and lights are equal", () => {
    const u = QUALITY_PRESETS.high;
    for (const name of QUALITY_ORDER) {
      const p = QUALITY_PRESETS[name];
      expect(p.gtao, `${name} must keep ambient occlusion`).toBe(true);
      expect(p.bloom, `${name} bloom`).toBe(true);
      expect(p.fxDensity, `${name} fx density`).toBe(u.fxDensity);
      expect(p.moteDensity, `${name} mote density`).toBe(u.moteDensity);
      // Light-pool sizes are read once, when the pools are built during
      // prewarm; a mode declaring a different count describes nothing.
      expect(p.fxLights, `${name} fx lights`).toBe(u.fxLights);
      expect(p.torchLights, `${name} torch lights`).toBe(u.torchLights);
    }
  });

  it("resolution still moves down the ladder — it is just no longer the only lever", () => {
    const caps = QUALITY_ORDER.map((n) => QUALITY_PRESETS[n].pixelRatioCap);
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeLessThan(caps[i - 1]);
    // ...and the CPU levers move too, which is the whole point of the re-cut.
    const rigs = QUALITY_ORDER.map((n) => rigWeight(QUALITY_PRESETS[n]));
    for (let i = 1; i < rigs.length; i++) expect(rigs[i]).toBeLessThan(rigs[i - 1]);
  });

  // A GATED RIG STILL ANIMATES. The mechanism is a RATE, not a switch: an
  // off-screen body accumulates dt and flushes a larger mixer.update, so clips
  // still finish and a body never walks back on screen wedged mid-swing. A mode
  // declaring 0 Hz would be declaring "freeze", which is a different and much
  // worse thing than what was measured and shipped.
  it("no mode freezes a rig outright", () => {
    for (const name of QUALITY_ORDER) {
      expect(QUALITY_PRESETS[name].offscreenRigHz, `${name} off-screen rig rate`)
        .toBeGreaterThan(0);
      expect(QUALITY_PRESETS[name].rigBudget, `${name} rig budget`).toBeGreaterThan(0);
    }
  });

  // The reference viewport is dpr 2, so a cap above 2 would be a field that
  // does nothing, and the weights must stay in 0..1 or the model is nonsense.
  it("the weight functions stay in range for every shipped mode", () => {
    for (const name of QUALITY_ORDER) {
      const p = QUALITY_PRESETS[name];
      expect.soft(referenceMegapixels(p)).toBeLessThanOrEqual((1440 * 852 * 4) / 1e6 + 1e-9);
      expect.soft(shadowWeight(p)).toBeGreaterThanOrEqual(0);
      expect.soft(shadowWeight(p)).toBeLessThanOrEqual(1);
      expect.soft(rigWeight(p)).toBeGreaterThan(0);
      expect.soft(rigWeight(p)).toBeLessThanOrEqual(1);
    }
  });
});

describe("quality auto-tuner", () => {
  it("leaves a machine that hits the budget alone", () => {
    const t = new QualityAutoTuner("high");
    expect(run(t, 14, 30)).toEqual([]);
    expect(t.current).toBe("high");
  });

  it("steps down, one mode at a time, on a machine that misses it", () => {
    const t = new QualityAutoTuner("high");
    const changes = run(t, 48, 60);
    expect(changes[0]).toBe("medium");
    expect(changes).toEqual(QUALITY_ORDER.slice(1, 1 + changes.length));
  });

  it("never descends past the cheapest mode", () => {
    const t = new QualityAutoTuner("high");
    run(t, 200, 600);
    expect(t.current).toBe("low");
  });

  // The failure mode that makes an auto-tuner worse than no tuner: visibly
  // flipping modes back and forth forever on a borderline machine.
  it("does not oscillate once a mode has proven too expensive", () => {
    const t = new QualityAutoTuner("high");
    run(t, 48, 60);            // forced down to at least "medium"
    const settled = t.current;
    expect(settled).not.toBe("high");
    // Now the machine looks gloriously fast. It must NOT climb back into a mode
    // that already missed.
    run(t, 4, 120);
    expect(t.current).toBe(settled);
  });

  it("climbs back up only from a too-pessimistic starting guess", () => {
    const t = new QualityAutoTuner("low");
    const changes = run(t, 5, 60);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]).toBe("medium");
  });

  // THE BIMODAL TRAP. When the frame is bottlenecked, rAF queues cheap frames
  // and then blocks for a long one; the median stays tiny while throughput
  // collapses. A median-based tuner reads this distribution as "60+ fps" and
  // never downgrades. This is the exact shape measured at native resolution:
  // p50 10 ms, p90 145 ms, actually delivering 24 fps.
  it("judges throughput, not the median frame time", () => {
    const t = new QualityAutoTuner("high");
    const changes: QualityName[] = [];
    for (let i = 0; i < 4000; i++) {
      // Two cheap frames then one very expensive one: median 6 ms, mean 43 ms.
      const next = t.sample(i % 3 === 2 ? 118 : 6);
      if (next) changes.push(next);
    }
    expect(changes[0]).toBe("medium");
  });

  // Shader builds and tab-switches produce isolated multi-second frames that no
  // mode can prevent — downgrading for them just costs quality for nothing.
  it("ignores stalls that a downgrade could not have prevented", () => {
    const t = new QualityAutoTuner("high");
    const changes: QualityName[] = [];
    for (let i = 0; i < 3000; i++) {
      const next = t.sample(i % 200 === 0 ? 3000 : 12);
      if (next) changes.push(next);
    }
    expect(changes).toEqual([]);
  });

  // THE DEMOTION-BY-A-HAIR TRAP, now tied to the measurement instead of a
  // remembered number. MEDIUM's WORST measured scene on the weak path is what
  // it is; a tuner that demotes a machine for hitting its own contract is
  // broken, and `ceiling` would make the demotion permanent for the session.
  it("does not demote a machine that is meeting its mode's contract", () => {
    const t = new QualityAutoTuner("medium");
    expect(run(t, MEASURED.medium.igpu, 120)).toEqual([]);
    expect(t.current).toBe("medium");
    // The threshold must sit above MEDIUM's own declared ceiling, or the mode
    // demotes itself at exactly the frame time it promised was acceptable.
    const t2 = new QualityAutoTuner("medium");
    expect(run(t2, QUALITY_PRESETS.medium.contract.budgetMs! - 0.5, 120)).toEqual([]);
  });

  it("reports the evidence behind a decision, so a notice can quote it", () => {
    const t = new QualityAutoTuner("high");
    run(t, 48, 60);
    expect(t.lastWindowMs).toBeGreaterThan(40);
    expect(t.lastWindowMs).toBeLessThan(60);
  });

  it("a manual pin re-bases the tuner without letting it climb away", () => {
    const t = new QualityAutoTuner("high");
    t.reset("medium");
    expect(t.current).toBe("medium");
    run(t, 4, 120);
    expect(t.current).toBe("medium");
  });
});


describe("quality: a phone is a phone even when it will not say so", () => {
  /**
   * The mode and the touch layout must agree about what a device IS.
   * MOBILE.md §4.1's four classes are the same short-edge axis guessQuality
   * reads, so they are pinned together here: a `compact`/`phone` boots LOW, a
   * `tablet-*` boots MEDIUM, and neither needs Safari to expose
   * WEBGL_debug_renderer_info (it does not).
   */
  it("the mobile mode lines up with the four MOBILE.md device classes", () => {
    const rows: [number, string, string][] = [
      [293, "compact", "low"],      // Pixel 5 landscape
      [342, "compact", "low"],      // iPhone 13 landscape
      [380, "phone", "low"],        // iPhone 13 Pro Max landscape
      [810, "tablet-s", "medium"],  // iPad 7
      [834, "tablet-s", "medium"],  // iPad Pro 11
      [1024, "tablet-l", "medium"], // iPad Pro 12.9
    ];
    for (const [edge, cls, mode] of rows) {
      expect.soft(deviceClass(edge, true), `class at ${edge}`).toBe(cls);
      expect.soft(guessQuality(null, { coarse: true, shortEdge: edge }), `mode at ${edge}`)
        .toBe(mode);
    }
  });

  it("a coarse pointer on a short screen picks LOW without the GL extension", () => {
    // Safari exposes no WEBGL_debug_renderer_info, so the renderer string is
    // empty; before this branch existed, an iPhone fell through to the desktop
    // default and booted at dpr 3 with no meaningful pixel-ratio cap.
    expect(guessQuality(null, { coarse: true, shortEdge: 390 })).toBe("low");
    expect(guessQuality(null, { coarse: true, shortEdge: 342 })).toBe("low");
  });

  it("a tablet picks MEDIUM — the mode that promises 30 fps", () => {
    expect(guessQuality(null, { coarse: true, shortEdge: 834 })).toBe("medium");
    expect(guessQuality(null, { coarse: true, shortEdge: 810 })).toBe("medium");
  });

  it("a desktop touchscreen is not a phone", () => {
    expect(guessQuality(null, { coarse: true, shortEdge: 1440 })).not.toBe("low");
    expect(guessQuality(null, {})).not.toBe("low");
  });

  it("an explicit renderer string still wins where the browser provides one", () => {
    const gl = {
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 1 }),
      getParameter: () => "Adreno (TM) 650",
    } as unknown as WebGL2RenderingContext;
    expect(guessQuality(gl, { coarse: false, shortEdge: 2000 })).toMatch(/low|medium/);
  });

  // THE STARTUP GUESS NEVER PICKS THE MODE WITH NO PROMISE.
  //
  // The four-rung ladder started an unknown machine at its TOP rung and let the
  // tuner descend. That cannot survive the re-cut: HIGH is explicitly the mode
  // with no frame-rate contract, so booting an unidentified machine into it
  // hands the player an unbounded frame time they never chose. MEDIUM is the
  // floor of the guess; the tuner climbs from there if the machine earns it.
  it("never guesses HIGH — an unknown machine starts on a mode that promises something", () => {
    const cases: Parameters<typeof guessQuality>[1][] = [
      {}, { coarse: false }, { coarse: true, shortEdge: 1440 },
      { coarse: false, shortEdge: 3840 }, { coarse: true, shortEdge: 2000 },
    ];
    for (const hint of cases) {
      expect.soft(guessQuality(null, hint), `hint ${JSON.stringify(hint)}`).not.toBe("high");
      expect.soft(QUALITY_PRESETS[guessQuality(null, hint)].contract.budgetMs).not.toBeNull();
    }
  });
});
