// THE ABLATION LADDER, run inside ONE page load so every variant shares the
// same scene, the same compiled programs and the same machine weather.
//
// The question it answers: when the frame gets cheaper, WHY? If cutting pixel
// count 4x barely moves the frame, raster is not the wall. If freezing the
// scene-graph matrices moves it, the wall is JS. If dropping the post chain
// moves it, the wall is pass submission.
//
// Variants are interleaved across reps so slow drift (thermals, roaming mobs)
// is shared by all of them rather than smeared onto whichever ran last.
//
// Usage: node tools/trk_ablate.mjs --adapter igpu|dgpu [--reps 3] [--secs 2.5]
//                                  [--port 5282] [--scene dense|combat]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { census } from "./trk_census.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const adapter = flag("--adapter", "igpu");
const reps = Number(flag("--reps", 3));
const secs = Number(flag("--secs", 2.5));
const port = Number(flag("--port", 5282));
const sceneKind = flag("--scene", "dense");
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));
const quality = flag("--quality", "high");

const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };

const url = `http://localhost:${port}/iso.html?test&floor=15&level=26&seed=41&abilities=all&debug=1&quality=${quality}`;

const browser = await chromium.launch({
  headless: false,
  args: [...ADAPTERS[adapter], "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
let out = null;
try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 });
  await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 240000 });
  await page.waitForTimeout(3000);
  const box = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return { gone: true };
    const r = e.getBoundingClientRect();
    return { gone: r.width === 0 && r.height === 0, w: r.width, h: r.height };
  });
  if (!box.gone) throw new Error(`#loading still has a box: ${JSON.stringify(box)}`);
  const gpu = await page.evaluate(() => {
    const gl = window.__dcc.renderer.renderer.getContext();
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  if (!EXPECT[adapter].test(gpu)) throw new Error(`adapter=${adapter} but game context is "${gpu}"`);
  console.log("GAME CONTEXT GPU:", gpu);

  // walk into the level so streaming/dressing is resident, then stand still so
  // the SCENE stops changing under the ladder
  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  if (sceneKind === "combat") {
    await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
    for (const k of ["Space", "q", "e", "r"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(120); }
  }
  await page.waitForTimeout(2000);
  // FREEZE THE SCENE. The ladder takes ~2 minutes and the world moves under it
  // — mobs converge on a standing player, so a variant measured late is charged
  // for drift, not for its ablation. The character sheet (`p`) pauses the local
  // sim (main3d's frame loop zeroes the accumulator for any open panel) while
  // the renderer keeps drawing the same world every frame. Same pixels, same
  // draws, no drift.
  if (has("--freeze")) {
    await page.keyboard.press("p");
    await page.waitForTimeout(1200);
    const frozen = await page.evaluate(() => document.getElementById("sheet")?.style.display);
    console.log("FREEZE: #sheet display =", frozen);
  }

  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const gl = r3d.renderer;
    const raw = gl.getContext();
    gl.info.autoReset = false;
    const S = { frame: [], update: [], render: [], drain: [], calls: 0, frames: 0 };
    window.__A = S;
    const oU = r3d.update.bind(r3d);
    r3d.update = function (...a) { const t = performance.now(); const r = oU(...a); S.update.push(performance.now() - t); return r; };
    const oR = r3d.render.bind(r3d);
    r3d.render = function (...a) {
      gl.info.reset();
      const t = performance.now(); const r = oR(...a); S.render.push(performance.now() - t);
      S.calls += gl.info.render.calls; S.frames++;
      if (S.frames % 8 === 0) { const d = performance.now(); raw.finish(); S.drain.push(performance.now() - d); }
      return r;
    };
    let last = performance.now();
    const tick = () => { const n = performance.now(); S.frame.push(n - last); last = n; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);

    // ---- variant switchboard -------------------------------------------
    const passByName = (n) => r3d.composer.passes.find((p) => p.constructor.name === n);
    const saved = {
      shadow: gl.shadowMap.enabled,
      passes: r3d.composer.passes.map((p) => p.enabled),
      autoMat: r3d.scene.matrixWorldAutoUpdate,
      scale: 1,
    };
    const setPass = (name, on) => { const p = passByName(name); if (p) p.enabled = on; };
    const eachSkinnedRoot = (fn) => {
      r3d.scene.traverse((o) => { if (o.isSkinnedMesh) fn(o); });
    };
    window.__reset = () => {
      gl.shadowMap.enabled = saved.shadow;
      r3d.composer.passes.forEach((p, i) => { p.enabled = saved.passes[i]; });
      r3d.scene.matrixWorldAutoUpdate = saved.autoMat;
      if (saved.scale !== 1) { r3d.setRenderScale(1); saved.scale = 1; }
      eachSkinnedRoot((o) => { o.visible = true; });
      window.__mixerOff = false;
    };
    window.__apply = (v) => {
      window.__reset();
      if (v === "baseline") return;
      if (v === "half-pixels") { r3d.setRenderScale(0.5); saved.scale = 0.5; return; }   // 1/4 the pixels
      if (v === "no-shadows") { gl.shadowMap.enabled = false; return; }
      if (v === "no-gtao") { setPass("GTAOPass", false); return; }
      if (v === "no-bloom") { setPass("UnrealBloomPass", false); return; }
      if (v === "no-smaa") { setPass("SMAAPass", false); return; }
      if (v === "no-post") { for (const n of ["GTAOPass", "UnrealBloomPass", "SMAAPass"]) setPass(n, false); return; }
      if (v === "no-post-no-shadows") {
        for (const n of ["GTAOPass", "UnrealBloomPass", "SMAAPass"]) setPass(n, false);
        gl.shadowMap.enabled = false; return;
      }
      if (v === "frozen-matrices") { r3d.scene.matrixWorldAutoUpdate = false; return; }
      if (v === "no-skinned") { eachSkinnedRoot((o) => { o.visible = false; }); return; }
    };
    window.__reset2 = () => {
      S.frame.length = 0; S.update.length = 0; S.render.length = 0; S.drain.length = 0;
      S.calls = 0; S.frames = 0;
    };
    window.__dump = () => {
      const st = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[s.length >> 1].toFixed(2); };
      return {
        frames: S.frames, frame: st(S.frame), update: st(S.update), render: st(S.render),
        drain: st(S.drain), calls: +(S.calls / Math.max(1, S.frames)).toFixed(0),
        buf: [raw.drawingBufferWidth, raw.drawingBufferHeight],
      };
    };
  });

  const ALL = ["baseline", "half-pixels", "no-shadows", "no-gtao", "no-bloom", "no-smaa",
    "no-post", "no-post-no-shadows", "frozen-matrices", "no-skinned"];
  // A short ladder finishes inside a clean gap between the sibling's browsers.
  const VARIANTS = flag("--variants", null)?.split(",") ?? ALL;
  const acc = new Map(VARIANTS.map((v) => [v, []]));
  let dropped = 0;
  const foreignFloor = census().foreign;
  console.log(`[contamination] baseline foreign browsers = ${foreignFloor}` +
    (foreignFloor ? "  -> ABSOLUTE frame times are inflated; only the DELTAS are quotable" : "  -> clean box"));

  // ROTATE THE ORDER EVERY REP. The scene drifts while the ladder runs (mobs
  // converge on a standing player), so a fixed order charges every variant the
  // drift accumulated since baseline — the first run of this read "disabling
  // GTAO makes the frame SLOWER", which is just position bias. Rotating gives
  // each variant every slot.
  for (let rep = 0; rep <= reps; rep++) {
    const order = VARIANTS.map((_, i) => VARIANTS[(i + rep * 3) % VARIANTS.length]);
    for (const v of order) {
      await page.evaluate((vv) => window.__apply(vv), v);
      await page.waitForTimeout(700);           // let the change settle / recompile
      const cBefore = census();
      await page.evaluate(() => window.__reset2());
      await page.waitForTimeout(secs * 1000);
      const d = await page.evaluate(() => window.__dump());
      const cAfter = census();
      // PER-SAMPLE CONTAMINATION GATE. A sibling can (and did) launch in the
      // middle of a 2.5-minute ladder, which charges whichever variants were
      // running at the time. Drop those samples instead of averaging them in.
      //
      // Two gates, because on this box the sibling is often NEVER absent:
      //   --clean   accept only samples with zero foreign browsers (absolutes
      //             are then trustworthy)
      //   default   accept only samples taken at the SAME foreign count the run
      //             started at, and drop the ones straddling a change. Absolute
      //             frame times are then inflated and must not be quoted, but
      //             the DELTAS between variants are still comparable because
      //             every variant paid the same tax.
      d.foreign = Math.max(cBefore.foreign ?? 99, cAfter.foreign ?? 99);
      const stable = cBefore.foreign === cAfter.foreign;
      // The sibling's browser count is not merely non-zero, it CHURNS (11 -> 19
      // -> 27 -> 11 within a minute), so pinning to a fixed floor drops every
      // sample. The workable gate is stability WITHIN the sample: the count did
      // not move while this variant was being timed. Rotation across reps then
      // spreads the remaining level differences evenly over the variants and the
      // median absorbs them.
      const ok = has("--clean") ? d.foreign === 0 : stable;
      if (!ok) dropped++;
      if (rep > 0 && ok) acc.get(v).push(d); // rep 0 is warmup
    }
  }
  if (dropped) console.log(`!! dropped ${dropped} sample(s) taken while a foreign browser was live`);
  await page.evaluate(() => window.__apply("baseline"));

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[s.length >> 1].toFixed(2) : null; };
  const rows = VARIANTS.map((v) => {
    const rs = acc.get(v);
    return {
      variant: v,
      frameMs: med(rs.map((r) => r.frame)),
      updateMs: med(rs.map((r) => r.update)),
      renderMs: med(rs.map((r) => r.render)),
      drainMs: med(rs.map((r) => r.drain)),
      calls: med(rs.map((r) => r.calls)),
      buf: rs[0]?.buf,
      n: rs.length,
    };
  });
  const base = rows[0].frameMs;
  console.log(`\n=== ABLATION LADDER · ${adapter.toUpperCase()} · scene=${sceneKind} · ${reps} reps x ${secs}s ===`);
  console.log("variant               frameMs   delta   update  render   drain  calls   n  buffer");
  for (const r of rows) {
    const d = (r.frameMs - base);
    console.log(
      r.variant.padEnd(20),
      String(r.frameMs).padStart(7),
      `${d >= 0 ? "+" : ""}${d.toFixed(2)}`.padStart(8),
      String(r.updateMs).padStart(8),
      String(r.renderMs).padStart(7),
      String(r.drainMs).padStart(7),
      String(r.calls).padStart(6),
      String(r.n).padStart(3),
      ` ${r.buf?.join("x")}`,
    );
  }
  out = { adapter, gpu, sceneKind, reps, secs, width, height, dpr, quality, rows, raw: [...acc] };
} finally {
  await browser.close();
}
writeFileSync(`tools/_trkablate_${adapter}_${sceneKind}.json`, JSON.stringify(out, null, 1));
console.log(`\nwrote tools/_trkablate_${adapter}_${sceneKind}.json`);
