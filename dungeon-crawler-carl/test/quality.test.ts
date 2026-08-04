import { describe, expect, it } from "vitest";
import {
  CPU_PROFILE, MEASURED, MODE_SWITCH, QUALITY_ORDER, QUALITY_PRESETS, QualityAutoTuner,
  SCENES, SHADER_BUILDS_PER_MIN, WORST_SCENE,
  guessQuality, postWeight, referenceMegapixels, rigWeight, shadowWeight,
  type Adapter, type QualityName, type SceneName,
} from "../src/render3d/quality";
import { deviceClass } from "../src/input/touchLayout";

const ADAPTERS: Adapter[] = ["igpu", "dgpu"];
const SCENE_NAMES = Object.keys(SCENES) as SceneName[];

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
  it("the budgets are the ones the measurement could actually support", () => {
    // LOW USED TO SAY 16.7 ms, THEN 20 ms WITH A CEILING NOTHING GRADED. The
    // budget is pinned here so it cannot drift back to being an aspiration.
    expect(QUALITY_PRESETS.low.contract.budgetMs).toBe(20);
    expect(QUALITY_PRESETS.medium.contract.budgetMs).toBe(33.3);
    expect(QUALITY_PRESETS.high.contract.budgetMs).toBeNull();
    // And every gated mode also caps the SHARE of frames allowed over budget.
    // A throughput number on its own cannot see a stutter.
    expect(QUALITY_PRESETS.low.contract.maxOverPct).not.toBeNull();
    expect(QUALITY_PRESETS.medium.contract.maxOverPct).not.toBeNull();
    expect(QUALITY_PRESETS.high.contract.maxOverPct).toBeNull();
  });

  // THE WORST SCENE IS THE ONE THE GAME IS PLAYED IN.
  //
  // Every contract in this file used to be stated against a scene in which the
  // crawler was teleported into the densest pack and PINNED ALIVE — standing
  // still, never swinging. Staging the same pack with the crawler attacking and
  // spending abilities is worse in every mode while showing FEWER bodies, so
  // the cost was never the density: it is the combat FX. A ladder measured
  // standing still is a ladder measured in a scene nobody plays.
  it("the contract scene is the fight, and it really is the worst one", () => {
    expect(WORST_SCENE).toBe("fight");
    for (const name of QUALITY_ORDER) {
      for (const a of ADAPTERS) {
        expect.soft(MEASURED.fight[name][a].delivered, `${name} fight vs quiet on ${a}`)
          .toBeGreaterThan(MEASURED.quiet[name][a].delivered);
      }
    }
  });

  // THE PROMISE IS PLAYER-FACING TEXT AND IT IS CHECKED AS SUCH. The settings
  // row prints contract.promise verbatim, so a promise the measurement does not
  // support is a lie shipped to a player.
  it("no promise contains an absolute the measurement cannot support", () => {
    for (const name of QUALITY_ORDER) {
      const promise = QUALITY_PRESETS[name].contract.promise;
      expect.soft(promise, `${name} promise`).not.toMatch(/\bnever\b|\bguarantee|\balways\b/i);
    }
    for (const name of ["low", "medium"] as QualityName[]) {
      expect.soft(QUALITY_PRESETS[name].blurb, `${name} blurb`).not.toMatch(/guaranteed/i);
    }
  });

  // (1) WHAT WAS ON THE CLOCK, on DELIVERED time, in EVERY measured scene.
  it("the measured DELIVERED frame time is inside every declared budget, in every scene", () => {
    for (const scene of SCENE_NAMES) {
      for (const name of QUALITY_ORDER) {
        const budget = QUALITY_PRESETS[name].contract.budgetMs;
        if (budget === null) continue;
        expect.soft(MEASURED[scene][name].igpu.delivered, `${name} delivered on the Intel part, ${scene}`)
          .toBeLessThanOrEqual(budget);
      }
    }
  });

  // (2) THE CEILING IS GRADED AGAINST THE MODE'S OWN BUDGET. THIS IS THE FIX.
  //
  // The shipped version of this test asserted `table[name].over33 <=
  // maxOverPct` for EVERY mode — including LOW, whose budgetMs is 20, not 33.3.
  // maxOverPct is documented as "the SHARE of individual frames allowed over
  // budgetMs", so LOW's stated ceiling had never been evaluated once: it was
  // graded against a threshold 66% looser than the field describes, and LOW
  // passed at 5.8% while spending 18.6% of its frames over its actual budget.
  // MeasuredShape now carries `overBudget` for exactly this, and the two
  // numbers are asserted to be DIFFERENT for LOW below, so nobody can quietly
  // point this back at over33 and call it green.
  it("the share of frames over the mode's OWN budget is inside its ceiling, in every scene", () => {
    for (const scene of SCENE_NAMES) {
      for (const name of QUALITY_ORDER) {
        const cap = QUALITY_PRESETS[name].contract.maxOverPct;
        if (cap === null) continue;
        const m = MEASURED[scene][name].igpu;
        expect.soft(m.overBudget, `${name} frames over its ${QUALITY_PRESETS[name].contract.budgetMs} ms budget, ${scene}`)
          .not.toBeNull();
        expect.soft(m.overBudget!, `${name} frames over budget on the Intel part, ${scene}`)
          .toBeLessThanOrEqual(cap);
      }
    }
  });

  it("grading LOW on over33 instead of overBudget would have been the flattering read", () => {
    // The falsification of the fix: if these were the same number, the bug
    // would be invisible and this test would be decoration.
    const m = MEASURED[WORST_SCENE].low.igpu;
    expect(m.overBudget).not.toBeNull();
    expect(m.overBudget!).toBeGreaterThan(m.over33);
    expect(QUALITY_PRESETS.low.contract.budgetMs).toBeLessThan(33.3);
  });

  // (3) WHAT THE PRESET BUYS. (1) and (2) are facts about one build at one
  //     moment and they do not move when the preset does. THIS is the check
  //     that survives an edit.
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
  // vacuously — so each lever is nudged the wrong way and must break its own cap.
  it("the lever caps are tight — loosening any lever breaks its own cap", () => {
    const low = QUALITY_PRESETS.low;
    const c = low.contract;
    expect(shadowWeight({ ...low, shadowInterval: 1 }), "shadow cadence")
      .toBeGreaterThan(c.maxShadowCost);
    expect(shadowWeight({ ...low, shadowMapSize: 2048 }), "shadow map size")
      .toBeGreaterThan(c.maxShadowCost);
    expect(rigWeight({ ...low, offscreenRigHz: 30 }), "off-screen rig rate")
      .toBeGreaterThan(c.maxRigCost);
    expect(postWeight({ ...low, gtaoSamples: 12 }), "AO samples")
      .toBeGreaterThan(c.maxPostCost);
    expect(postWeight({ ...low, gtaoDenoiseScale: 0.5 }), "AO denoise scale")
      .toBeGreaterThan(c.maxPostCost);
    expect(postWeight({ ...low, bloomScale: 0.5 }), "bloom scale")
      .toBeGreaterThan(c.maxPostCost);
    expect(low.pixelRatioCap + 0.05, "pixel ratio").toBeGreaterThan(c.maxPixelRatio);
  });

  // THE LADDER IS A LADDER ON THE ADAPTER THE PROMISES ARE MADE TO, AND IT IS
  // NOT ONE ANYWHERE ELSE. On the Intel part each rung really is cheaper than
  // the one above it. On the RTX 5090 the order is not even monotone — LOW
  // measured 17.79 ms against MEDIUM's 16.78 — so asserting monotonicity on
  // both adapters would be asserting something false about the hardware. What
  // is asserted instead is the thing a player can be harmed by: LOW must never
  // be the slowest mode, and where the order does invert the modes must be
  // close enough that the inversion is noise rather than a cost.
  it("the ladder is monotone on the weak path, where the contracts live", () => {
    for (let i = 1; i < QUALITY_ORDER.length; i++) {
      expect.soft(MEASURED[WORST_SCENE][QUALITY_ORDER[i]].igpu.delivered, `measured ${QUALITY_ORDER[i]} on igpu`)
        .toBeLessThanOrEqual(MEASURED[WORST_SCENE][QUALITY_ORDER[i - 1]].igpu.delivered + 1e-9);
    }
  });

  it("on the discrete part the ladder is flat, and LOW is not the fastest rung", () => {
    const d = QUALITY_ORDER.map((n) => MEASURED[WORST_SCENE][n].dgpu.delivered);
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(5);
    // The inversion is real and it is why contract.discrete exists.
    expect(MEASURED[WORST_SCENE].low.dgpu.delivered)
      .toBeGreaterThan(MEASURED[WORST_SCENE].medium.dgpu.delivered);
  });

  // LOW MAY NOT BE THE SLOWEST MODE ANYWHERE. A player who picks the
  // performance mode and gets fewer frames AND a blurrier picture has been
  // harmed by the setting.
  it("the performance mode is not a pessimization on any adapter", () => {
    for (const a of ADAPTERS) {
      expect.soft(MEASURED[WORST_SCENE].low[a].fps, `LOW fps on ${a}`)
        .toBeGreaterThanOrEqual(MEASURED[WORST_SCENE].high[a].fps);
    }
  });

  // THE LADDER IS NEARLY FLAT ON THE DISCRETE PART, AND THE PLAYER IS TOLD SO.
  //
  // Measured on the RTX 5090 the three modes land within a fraction of each
  // other, so a player who picks LOW there buys a softer picture and almost no
  // frames. The previous ladder carried a whole dgpu column that no contract
  // read and no promise text mentioned; `contract.discrete` is the sentence the
  // settings row prints when the renderer string is not an integrated part.
  it("the discrete-GPU note exists on every mode and says the ladder is flat", () => {
    for (const name of QUALITY_ORDER) {
      const d = QUALITY_PRESETS[name].contract.discrete;
      expect.soft(d, `${name} discrete note`).toBeTruthy();
      expect.soft(d.length, `${name} discrete note length`).toBeGreaterThan(20);
    }
    expect(QUALITY_PRESETS.low.contract.discrete).toMatch(/soft|little|barely|no faster|nothing/i);
  });

  it("the ladder barely exists on the discrete GPU — the two adapters are different machines", () => {
    const spread = (a: Adapter) =>
      MEASURED[WORST_SCENE].high[a].delivered - MEASURED[WORST_SCENE].low[a].delivered;
    expect(spread("dgpu")).toBeLessThan(spread("igpu") / 2);
  });

  // THE MEDIAN IS CARRIED ONLY TO SHOW HOW FAR IT LIES. It is the statistic the
  // original contract was pinned to.
  it("the median still flatters the Intel frame more than the discrete one", () => {
    const flatter = (n: QualityName, a: Adapter) =>
      MEASURED[WORST_SCENE][n][a].delivered / MEASURED[WORST_SCENE][n][a].p50;
    expect(flatter("high", "igpu")).toBeGreaterThan(flatter("high", "dgpu"));
  });

  // THE ROUND HAS TO HAVE MOVED SOMETHING, AND THE EVIDENCE IS THE PROFILE.
  //
  // A wall-clock before/after is not evidence on this box. What IS evidence is
  // the V8 sampling profile of the same fight window: two entries that were
  // together ~23% of the main thread are gone from it entirely.
  it("the main-thread costs this round removed are named, and they were large", () => {
    for (const row of CPU_PROFILE.removed) {
      expect.soft(row.beforeMsPerFrame, `${row.what} before`).toBeGreaterThan(0.5);
      expect.soft(row.afterMsPerFrame, `${row.what} after`).toBeLessThan(0.05);
    }
    const before = CPU_PROFILE.removed.reduce((a, r) => a + r.beforeMsPerFrame, 0);
    expect(before / CPU_PROFILE.deliveredMsBefore).toBeGreaterThan(0.15);
  });

  // THE SHADER-BUILD TAIL IS NOT CLOSED, AND THE FILE MAY NOT SAY IT IS.
  //
  // The previous round recorded `after: 0` and "across 4.1 minutes of measured
  // play after: zero fires". Re-measured on a quiet box with the contamination
  // meter reading zero foreign browsers, the shipped build still fires several
  // times a minute. The claim is now the measurement, and this test exists to
  // stop a zero being written here again without one.
  it("the shader-build rate is stated as measured, not as hoped", () => {
    expect(SHADER_BUILDS_PER_MIN.after).toBeGreaterThan(0);
    // The retracted claim is kept next to the measurement so the retraction is
    // legible rather than a silent edit. A future round that writes a zero here
    // has to delete this line to do it.
    expect(SHADER_BUILDS_PER_MIN.claimedByR2).toBe(0);
    expect(SHADER_BUILDS_PER_MIN.after).not.toBe(SHADER_BUILDS_PER_MIN.claimedByR2);
  });

  // A MODE CHANGE COSTS A LONG FRAME, AND applyQuality MAY NOT CALL IT CHEAP.
  // A MODE CHANGE COSTS A LONG TASK, AND applyQuality MAY NOT CALL IT CHEAP.
  // The hitch is INSIDE the synchronous call — the frames after it are
  // indistinguishable from a same-staging control — and it builds no shader
  // programs at all, so it is buffer reallocation exactly as the doc comment
  // says and reallocation is not free.
  it("the mode-switch hitch is measured, and it is allocation rather than compilation", () => {
    expect(MODE_SWITCH.programsBuilt).toBe(0);
    expect(MODE_SWITCH.applyMs).toBeGreaterThan(20 * MODE_SWITCH.worstFrameMs / 20);
    expect(MODE_SWITCH.applyMs).toBeGreaterThan(100);
    // The cost does NOT spill into the following frames, which is why the fix
    // is to shorten the call rather than to widen the tuner's settle window.
    expect(Math.abs(MODE_SWITCH.worstFrameMs - MODE_SWITCH.controlWorstFrameMs)).toBeLessThan(5);
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
      expect(lo.offscreenRigHz, `${lo.name} off-screen rig rate`).toBeLessThanOrEqual(hi.offscreenRigHz);
      expect(lo.gtaoDenoiseScale, `${lo.name} AO denoise scale`).toBeLessThanOrEqual(hi.gtaoDenoiseScale);
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
    expect(u.gtaoScale).toBeLessThan(1);
    expect(u.offscreenRigHz).toBe(Infinity);
  });

  // NO MODE CUTS CONTENT. The levers the modes DO spend (pixel ratio, rig
  // animation rate, shadow cadence, AO sampling) are softness and off-screen
  // work, not things a player can name as missing.
  it("no mode cuts content — occlusion, particles, motes and lights are equal", () => {
    const u = QUALITY_PRESETS.high;
    for (const name of QUALITY_ORDER) {
      const p = QUALITY_PRESETS[name];
      expect(p.gtao, `${name} must keep ambient occlusion`).toBe(true);
      expect(p.bloom, `${name} bloom`).toBe(true);
      expect(p.fxDensity, `${name} fx density`).toBe(u.fxDensity);
      expect(p.moteDensity, `${name} mote density`).toBe(u.moteDensity);
      // Light-pool sizes are read once, when the pools are built during
      // prewarm; a mode declaring a different count describes nothing. The
      // measured price of that constraint is in POINT_LIGHT_SHARE.
      expect(p.fxLights, `${name} fx lights`).toBe(u.fxLights);
      expect(p.torchLights, `${name} torch lights`).toBe(u.torchLights);
    }
  });

  it("resolution still moves down the ladder — it is just no longer the only lever", () => {
    const caps = QUALITY_ORDER.map((n) => QUALITY_PRESETS[n].pixelRatioCap);
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeLessThan(caps[i - 1]);
    const rigs = QUALITY_ORDER.map((n) => rigWeight(QUALITY_PRESETS[n]));
    for (let i = 1; i < rigs.length; i++) expect(rigs[i]).toBeLessThan(rigs[i - 1]);
  });

  it("no mode freezes a rig outright", () => {
    for (const name of QUALITY_ORDER) {
      expect(QUALITY_PRESETS[name].offscreenRigHz, `${name} off-screen rig rate`)
        .toBeGreaterThan(0);
    }
  });

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

  it("every scene the contracts are stated against describes how it was staged", () => {
    for (const s of SCENE_NAMES) {
      expect.soft(SCENES[s].length, `${s} description`).toBeGreaterThan(120);
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

  it("does not oscillate once a mode has proven too expensive", () => {
    const t = new QualityAutoTuner("high");
    run(t, 48, 60);
    const settled = t.current;
    expect(settled).not.toBe("high");
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
  // collapses. A median-based tuner reads this as "60+ fps" and never downgrades.
  it("judges throughput, not the median frame time", () => {
    const t = new QualityAutoTuner("high");
    const changes: QualityName[] = [];
    for (let i = 0; i < 4000; i++) {
      const next = t.sample(i % 3 === 2 ? 118 : 6);
      if (next) changes.push(next);
    }
    expect(changes[0]).toBe("medium");
  });

  it("ignores stalls that a downgrade could not have prevented", () => {
    const t = new QualityAutoTuner("high");
    const changes: QualityName[] = [];
    for (let i = 0; i < 3000; i++) {
      const next = t.sample(i % 200 === 0 ? 3000 : 12);
      if (next) changes.push(next);
    }
    expect(changes).toEqual([]);
  });

  it("does not demote a machine that is meeting its mode's contract", () => {
    const t = new QualityAutoTuner("medium");
    expect(run(t, MEASURED[WORST_SCENE].medium.igpu.delivered, 120)).toEqual([]);
    expect(t.current).toBe("medium");
    const t2 = new QualityAutoTuner("medium");
    expect(run(t2, QUALITY_PRESETS.medium.contract.budgetMs! - 0.5, 120)).toEqual([]);
  });

  // A MODE CHANGE IS EXPENSIVE, SO THE TUNER MAY NOT MAKE THEM CHEAPLY.
  // MODE_SWITCH.worstFrameMs is a measured multi-hundred-millisecond frame, and
  // the tuner fires this path on a machine it has just judged too slow. The
  // settle window has to be long enough that a downgrade cannot be immediately
  // followed by another one caused by its own hitch.
  it("waits out its own hitch before judging again", () => {
    const t = new QualityAutoTuner("high");
    const changes = run(t, 48, 60);
    expect(changes.length).toBeGreaterThan(0);
    // A window is 1.5 s; two settle windows must exceed the worst switch frame
    // by a wide margin or the hitch lands inside the next judged window.
    expect(2 * 1500).toBeGreaterThan(MODE_SWITCH.worstFrameMs * 3);
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
  it("the mobile mode lines up with the four MOBILE.md device classes", () => {
    const rows: [number, string, string][] = [
      [293, "compact", "low"],
      [342, "compact", "low"],
      [380, "phone", "low"],
      [810, "tablet-s", "medium"],
      [834, "tablet-s", "medium"],
      [1024, "tablet-l", "medium"],
    ];
    for (const [edge, cls, mode] of rows) {
      expect.soft(deviceClass(edge, true), `class at ${edge}`).toBe(cls);
      expect.soft(guessQuality(null, { coarse: true, shortEdge: edge }), `mode at ${edge}`)
        .toBe(mode);
    }
  });

  it("a coarse pointer on a short screen picks LOW without the GL extension", () => {
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

  it("never guesses HIGH on an UNKNOWN machine — it starts on a mode that promises something", () => {
    const cases: Parameters<typeof guessQuality>[1][] = [
      {}, { coarse: false }, { coarse: true, shortEdge: 1440 },
      { coarse: false, shortEdge: 3840 }, { coarse: true, shortEdge: 2000 },
    ];
    for (const hint of cases) {
      expect.soft(guessQuality(null, hint), `hint ${JSON.stringify(hint)}`).not.toBe("high");
      expect.soft(QUALITY_PRESETS[guessQuality(null, hint)].contract.budgetMs).not.toBeNull();
    }
  });

  it("an IDENTIFIED discrete GPU boots HIGH; integrated and ambiguous parts do not", () => {
    const glFor = (renderer: string) => ({
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 1 }),
      getParameter: () => renderer,
    } as unknown as WebGL2RenderingContext);
    // The measured case this branch exists for (tools/_ad4/capture.json):
    // an RTX 5090 Laptop GPU was booting MEDIUM at pixelRatio 1.4.
    const discrete = [
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Laptop GPU (0x00002C58) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "NVIDIA Quadro RTX 4000/PCIe/SSE2",
    ];
    for (const r of discrete) {
      expect.soft(guessQuality(glFor(r), { coarse: false }), r).toBe("high");
    }
    // The contract hardware and its relatives stay on the promising mode.
    const notDiscrete = [
      "ANGLE (Intel, Intel(R) Graphics (0x0000B0A0) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (Intel, Intel(R) Arc(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", // Meteor Lake iGPU
      "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", // APU
      "llvmpipe (LLVM 15.0.7, 256 bits)",
    ];
    for (const r of notDiscrete) {
      expect.soft(guessQuality(glFor(r), { coarse: false }), r).toBe("medium");
    }
    // A phone-shaped device never reaches the discrete branch.
    expect(guessQuality(glFor("NVIDIA GeForce RTX 9999"), { coarse: true, shortEdge: 390 }))
      .toBe("low");
  });
});
