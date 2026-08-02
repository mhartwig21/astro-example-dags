import { describe, expect, it } from "vitest";
import {
  QUALITY_ORDER, QUALITY_PRESETS, QualityAutoTuner, guessQuality, type QualityName,
} from "../src/render3d/quality";
import { deviceClass } from "../src/input/touchLayout";


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

describe("quality presets", () => {
  it("every rung is cheaper than the one above it on the levers that matter", () => {
    for (let i = 1; i < QUALITY_ORDER.length; i++) {
      const hi = QUALITY_PRESETS[QUALITY_ORDER[i - 1]];
      const lo = QUALITY_PRESETS[QUALITY_ORDER[i]];
      expect(lo.pixelRatioCap, `${lo.name} pixel ratio`).toBeLessThanOrEqual(hi.pixelRatioCap);
      expect(lo.shadowMapSize, `${lo.name} shadow map`).toBeLessThanOrEqual(hi.shadowMapSize);
      expect(lo.shadowInterval, `${lo.name} shadow cadence`).toBeGreaterThanOrEqual(hi.shadowInterval);
      expect(lo.bloomScale, `${lo.name} bloom scale`).toBeLessThanOrEqual(hi.bloomScale);
      expect(lo.fxDensity, `${lo.name} fx density`).toBeLessThanOrEqual(hi.fxDensity);
    }
  });

  // THE FINDING THIS FILE EXISTS FOR: a 4x MSAA HalfFloat composer target cost
  // ~85% of the frame on the target iGPU. No rung may quietly reintroduce it.
  it("no preset ships a multisampled HDR composer target", () => {
    for (const name of QUALITY_ORDER) {
      expect(QUALITY_PRESETS[name].msaaSamples, `${name} MSAA`).toBe(0);
      expect(QUALITY_PRESETS[name].smaa, `${name} needs SMAA to replace it`).toBe(true);
    }
  });

  it("ULTRA is the reference look: full pixel ratio, every effect on", () => {
    const u = QUALITY_PRESETS.ultra;
    expect(u.pixelRatioCap).toBe(2);
    expect(u.gtao).toBe(true);
    expect(u.bloom).toBe(true);
    expect(u.fxDensity).toBe(1);
    // Half-res AO is only free-of-quality-cost because the denoise pass runs at
    // full resolution and doubles as a depth-weighted bilateral upsample.
    expect(u.gtaoScale).toBeLessThan(1);
    expect(u.gtaoDenoiseScale).toBe(1);
  });

  // THE LADDER SPENDS RESOLUTION AND ONLY RESOLUTION.
  //
  // An earlier PERFORMANCE rung set gtao:false, fxDensity 0.6, moteDensity 0.5,
  // torchLights 5. Since auto-detect lands the reference machine near the
  // bottom of the ladder, that shipped the DEFAULT experience with ambient
  // occlusion off, half the motes and three torches missing. Those are losses a
  // player can name; pixel ratio is softness they mostly cannot. Anything that
  // reintroduces a content cut down the ladder should fail here and be argued
  // for on purpose.
  it("no rung cuts content — occlusion, particles, motes and lights are equal", () => {
    const u = QUALITY_PRESETS.ultra;
    for (const name of QUALITY_ORDER) {
      const p = QUALITY_PRESETS[name];
      expect(p.gtao, `${name} must keep ambient occlusion`).toBe(true);
      expect(p.bloom, `${name} bloom`).toBe(true);
      expect(p.fxDensity, `${name} fx density`).toBe(u.fxDensity);
      expect(p.moteDensity, `${name} mote density`).toBe(u.moteDensity);
      // Light-pool sizes are read once, when the pools are built during
      // prewarm; a rung declaring a different count describes nothing.
      expect(p.fxLights, `${name} fx lights`).toBe(u.fxLights);
      expect(p.torchLights, `${name} torch lights`).toBe(u.torchLights);
    }
  });

  it("resolution is the lever that actually moves down the ladder", () => {
    const caps = QUALITY_ORDER.map((n) => QUALITY_PRESETS[n].pixelRatioCap);
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeLessThan(caps[i - 1]);
  });
});

describe("quality auto-tuner", () => {
  it("leaves a machine that hits the budget alone", () => {
    const t = new QualityAutoTuner("ultra");
    expect(run(t, 14, 30)).toEqual([]);
    expect(t.current).toBe("ultra");
  });

  it("steps down, one rung at a time, on a machine that misses it", () => {
    const t = new QualityAutoTuner("ultra");
    const changes = run(t, 42, 60); // the measured ULTRA-at-native frame time
    expect(changes[0]).toBe("high");
    expect(changes).toEqual(QUALITY_ORDER.slice(1, 1 + changes.length));
  });

  it("never descends past the cheapest rung", () => {
    const t = new QualityAutoTuner("ultra");
    run(t, 200, 600);
    expect(t.current).toBe("performance");
  });

  // The failure mode that makes an auto-tuner worse than no tuner: visibly
  // flipping resolution back and forth forever on a borderline machine.
  it("does not oscillate once a rung has proven too expensive", () => {
    const t = new QualityAutoTuner("ultra");
    run(t, 42, 60);            // forced down to at least "high"
    const settled = t.current;
    expect(settled).not.toBe("ultra");
    // Now the machine looks gloriously fast. It must NOT climb back into a rung
    // that already missed.
    run(t, 4, 120);
    expect(t.current).toBe(settled);
  });

  it("climbs back up only from a too-pessimistic starting guess", () => {
    const t = new QualityAutoTuner("performance");
    const changes = run(t, 5, 60);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]).toBe("balanced");
  });

  // THE BIMODAL TRAP. When the GPU is the bottleneck, rAF queues cheap frames
  // and then blocks for a long one; the median stays tiny while throughput
  // collapses. A median-based tuner reads this distribution as "60+ fps" and
  // never downgrades. This is the exact shape measured at ULTRA/native:
  // p50 10 ms, p90 145 ms, actually delivering 24 fps.
  it("judges throughput, not the median frame time", () => {
    const t = new QualityAutoTuner("ultra");
    const changes: QualityName[] = [];
    for (let i = 0; i < 4000; i++) {
      // Two cheap frames then one very expensive one: median 6 ms, mean 43 ms.
      const next = t.sample(i % 3 === 2 ? 118 : 6);
      if (next) changes.push(next);
    }
    expect(changes[0]).toBe("high");
  });

  // Shader builds and tab-switches produce isolated multi-second frames that no
  // preset can prevent — downgrading for them just costs quality for nothing.
  it("ignores stalls that a downgrade could not have prevented", () => {
    const t = new QualityAutoTuner("ultra");
    const changes: QualityName[] = [];
    for (let i = 0; i < 3000; i++) {
      const next = t.sample(i % 200 === 0 ? 3000 : 12);
      if (next) changes.push(next);
    }
    expect(changes).toEqual([]);
  });

  // THE DEMOTION-BY-A-HAIR TRAP. BALANCED — the rung this ladder is designed to
  // land the reference machine on — measures ~17 ms mean in combat. With the
  // old 20 ms threshold that is inside the rung's own run-to-run spread, so two
  // unlucky windows demoted a machine that was hitting 59 fps, and `ceiling`
  // made it permanent for the session. The threshold must mean "not coping".
  it("does not demote a machine that is sitting on its target rung", () => {
    const t = new QualityAutoTuner("balanced");
    expect(run(t, 17, 120)).toEqual([]);
    expect(t.current).toBe("balanced");
  });

  it("a manual pin re-bases the tuner without letting it climb away", () => {
    const t = new QualityAutoTuner("ultra");
    t.reset("balanced");
    expect(t.current).toBe("balanced");
    run(t, 4, 120);
    expect(t.current).toBe("balanced");
  });
});


describe("quality: a phone is a phone even when it will not say so", () => {
  /**
   * The preset and the touch layout must agree about what a device IS.
   * MOBILE.md §4.1's four classes are the same short-edge axis guessQuality
   * reads, so they are pinned together here: a `compact`/`phone` boots
   * PERFORMANCE, a `tablet-*` boots BALANCED, and neither needs Safari to
   * expose WEBGL_debug_renderer_info (it does not).
   */
  it("the mobile preset lines up with the four MOBILE.md device classes", () => {
    const rows: [number, string, string][] = [
      [293, "compact", "performance"],   // Pixel 5 landscape
      [342, "compact", "performance"],   // iPhone 13 landscape
      [380, "phone", "performance"],     // iPhone 13 Pro Max landscape
      [810, "tablet-s", "balanced"],     // iPad 7
      [834, "tablet-s", "balanced"],     // iPad Pro 11
      [1024, "tablet-l", "balanced"],    // iPad Pro 12.9
    ];
    for (const [edge, cls, preset] of rows) {
      expect.soft(deviceClass(edge, true), `class at ${edge}`).toBe(cls);
      expect.soft(guessQuality(null, { coarse: true, shortEdge: edge }), `preset at ${edge}`)
        .toBe(preset);
    }
  });

  it("a coarse pointer on a short screen picks PERFORMANCE without the GL extension", () => {
    // Safari exposes no WEBGL_debug_renderer_info, so the renderer string is
    // empty; before this branch existed, an iPhone fell through to "cores > 4"
    // and booted at ULTRA with no pixel-ratio cap at dpr 3.
    expect(guessQuality(null, { coarse: true, shortEdge: 390 })).toBe("performance");
    expect(guessQuality(null, { coarse: true, shortEdge: 342 })).toBe("performance");
  });

  it("a tablet picks BALANCED — the measured 60 fps rung", () => {
    expect(guessQuality(null, { coarse: true, shortEdge: 834 })).toBe("balanced");
    expect(guessQuality(null, { coarse: true, shortEdge: 810 })).toBe("balanced");
  });

  it("a desktop touchscreen is not a phone", () => {
    expect(guessQuality(null, { coarse: true, shortEdge: 1440 })).not.toBe("performance");
    expect(guessQuality(null, {})).not.toBe("performance");
  });

  it("an explicit renderer string still wins where the browser provides one", () => {
    const gl = {
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 1 }),
      getParameter: () => "Adreno (TM) 650",
    } as unknown as WebGL2RenderingContext;
    expect(guessQuality(gl, { coarse: false, shortEdge: 2000 })).toMatch(/performance|balanced/);
  });
});
