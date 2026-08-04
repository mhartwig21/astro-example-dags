// THE POST CHAIN, PRICED PASS BY PASS — candidate optimisations, A/B'd live.
//
// The fill fit (tools/r2_fill.mjs) settled the argument quality.ts got backwards:
// on the Intel part, in dense floor-15 combat at HIGH,
//     delivered ms = 8.3 + 9.1 * backbuffer Mpx        (r^2 ~ 1 over 1.2-4.9 Mpx)
// So the frame is two things, not one: a large PER-PIXEL term (44.7 ms of HIGH's
// 53) and a real ~8.3 ms fixed term (which is 40% of LOW's frame and the reason
// LOW cannot reach 16.7 ms by shrinking the buffer alone).
//
// This harness attacks the per-pixel term. Every arm is a candidate change to
// the post chain, applied through the live objects so the A and the B share one
// page session, one shader cache and one scene.
//
// THE FIRST REP IS A WARM-UP AND IS NOT RECORDED. Measured twice: rep 0 of both
// earlier passes collapsed to 2-4 fps in EVERY arm while a rival browser had the
// shared package, which is the iGPU GPU-contention blind spot the contamination
// meter cannot see. A warm-up rep does not fix that, but it stops the one rep
// that is reliably worst from being pooled into the answer.
//
// Usage: node tools/r2_post.mjs --adapter igpu|dgpu [--mode high] [--secs 3] [--reps 3]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, window1, pool, flag } from "./r2lab.mjs";

const adapter = flag("--adapter", "igpu");
const mode = flag("--mode", "high");
const secs = Number(flag("--secs", 3));
const reps = Number(flag("--reps", 3));
const out = flag("--out", `tools/_r2post_${adapter}_${mode}.json`);

const ARMS = [
  "base", "gtao_off", "gtao_dn05", "gtao_s8", "gtao_dnq", "gtao_dn05_s8",
  "smaa_off", "grade_off", "bloom_off", "post_min",
];

const { browser, page } = await boot({ adapter });
try {
  await installProbe(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.waitForTimeout(600);
  await stage(page);

  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const gtao = r3d.gtao;
    const passes = r3d.composer.passes;
    const gradePass = passes.find((p) => p.constructor.name === "ShaderPass" && p !== r3d.smaa);
    const Q = r3d.qualityProfile;
    const AO = { radius: 0.55, distanceExponent: 1, thickness: 1, scale: 1.3, distanceFallOff: 1, screenSpaceRadius: false };
    const PD = { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2 };
    const restore = () => {
      gtao.enabled = Q.gtao;
      gtao.setResolutionScales(Q.gtaoScale, Q.gtaoDenoiseScale);
      gtao.updateGtaoMaterial({ ...AO, samples: Q.gtaoSamples });
      gtao.updatePdMaterial({ ...PD, samples: Q.gtaoDenoiseSamples });
      if (gradePass) gradePass.enabled = true;
      r3d.smaa.enabled = Q.smaa;
      r3d.bloom.enabled = Q.bloom;
    };
    const ARM = {
      base: () => {},
      gtao_off: () => { gtao.enabled = false; },
      // The denoise/upsample pass is the only FULL-RES half of GTAO. Half-res
      // + bilinear is what LOW already ships; this prices it at HIGH.
      gtao_dn05: () => gtao.setResolutionScales(Q.gtaoScale, 0.5),
      gtao_s8: () => gtao.updateGtaoMaterial({ ...AO, samples: 8 }),
      gtao_dnq: () => gtao.updatePdMaterial({ ...PD, samples: 4 }),
      gtao_dn05_s8: () => {
        gtao.setResolutionScales(Q.gtaoScale, 0.5);
        gtao.updateGtaoMaterial({ ...AO, samples: 8 });
      },
      smaa_off: () => { r3d.smaa.enabled = false; },
      grade_off: () => { if (gradePass) gradePass.enabled = false; },
      bloom_off: () => { r3d.bloom.enabled = false; },
      // Everything the chain could drop at once — the floor of what post costs.
      post_min: () => { gtao.enabled = false; r3d.smaa.enabled = false; if (gradePass) gradePass.enabled = false; r3d.bloom.enabled = false; },
    };
    window.__arm = (n) => { restore(); ARM[n](); };
    window.__disarm = restore;
  });

  // SANDWICHED A/B. The first attempt at this measurement pooled each arm's
  // windows and compared pooled means, and a run taken while a rival browser
  // owned the shared Intel package produced base=266 ms against a 53 ms base
  // measured twenty minutes earlier — with arm deltas of the same magnitude as
  // the drift. Absolute pooling cannot survive that.
  //
  // So every arm window is SANDWICHED between two base windows and scored as a
  // RATIO to the mean of its own two neighbours. Contention that lasts longer
  // than one window pair cancels; contention that does not is visible as a
  // disagreement between the arm's repeats, which is reported.
  const ratios = new Map(ARMS.filter((a) => a !== "base").map((a) => [a, []]));
  const bases = [];
  const runOne = async (arm) => {
    await page.evaluate((a) => window.__arm(a), arm);
    await page.waitForTimeout(250);
    try { return await window1(page, { secs }); } finally { await page.evaluate(() => window.__disarm()); }
  };
  const armList = ARMS.filter((a) => a !== "base");
  let prevBase = await runOne("base");
  console.log(`warm base delivered=${prevBase.shape.delivered}ms`);
  for (let r = 0; r < reps; r++) {
    const order = armList.map((_, i) => armList[(i + r) % armList.length]);
    for (const arm of order) {
      const w = await runOne(arm);
      const nextBase = await runOne("base");
      bases.push(prevBase, nextBase);
      const ref = (prevBase.shape.delivered + nextBase.shape.delivered) / 2;
      const ratio = w.shape.delivered / ref;
      ratios.get(arm).push({ ratio, ref, arm: w.shape.delivered, w });
      console.log(
        `r${r} ${arm.padEnd(13)} arm=${String(w.shape.delivered).padStart(7)}ms  base~${ref.toFixed(1)}ms  `
        + `ratio=${ratio.toFixed(3)}  saved=${(100 * (1 - ratio)).toFixed(1)}%  vis=${w.visible} foreign=${w.foreign}`,
      );
      prevBase = nextBase;
    }
  }

  const basePool = pool(bases);
  console.log(`\n=== ${adapter}/${mode} POST CANDIDATES — sandwiched A/B, ${reps} rotated reps ===`);
  console.log(`base (pooled ${bases.length} windows): ${basePool.delivered} ms delivered / ${basePool.fps} fps  p50=${basePool.p50} p90=${basePool.p90} p99=${basePool.p99} over33=${basePool.over33}%`);
  console.log("arm            median ratio   saved%   est ms saved   spread(min..max ratio)");
  const table = {};
  for (const a of armList) {
    const rs = ratios.get(a).map((x) => x.ratio).sort((x, y) => x - y);
    const med = rs[Math.floor(rs.length / 2)];
    table[a] = {
      ratios: rs, median: +med.toFixed(3),
      savedPct: +(100 * (1 - med)).toFixed(1),
      savedMs: +((1 - med) * basePool.delivered).toFixed(2),
    };
    console.log(
      `${a.padEnd(13)} ${String(med.toFixed(3)).padStart(12)} ${String(table[a].savedPct).padStart(8)} `
      + `${String(table[a].savedMs).padStart(14)}   ${rs[0].toFixed(3)}..${rs[rs.length - 1].toFixed(3)}`,
    );
  }
  writeFileSync(out, JSON.stringify({ adapter, mode, secs, reps, base: basePool, table }, null, 2));
  console.log(`\nwrote ${out}`);
} finally {
  await browser.close();
}
