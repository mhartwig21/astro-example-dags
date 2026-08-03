// THE MODE LADDER — what LOW / MEDIUM / HIGH actually cost, in one scene, on
// one adapter, inside ONE page load.
//
// This is the harness behind every number in src/render3d/quality.ts. The rules
// it exists to enforce, all of them learned the expensive way on this box:
//
//  1. ONE PAGE SESSION. Three separate launches would give the three modes
//     three different shader-program sets, three different asset-streaming
//     histories and three different thermal states. Modes are switched through
//     the SHIPPING path — renderer.setQuality() — which is also a live test
//     that a mode change needs no reload.
//
//  2. INTERLEAVED, WITH ROTATION. A fixed low->medium->high order charges the
//     later modes for whatever drifted since the first (mobs converge, floors
//     stream in, the package heats up). Every mode gets every slot.
//
//  3. THE ADAPTER IS ASSERTED ON THE GAME'S OWN CONTEXT. --use-angle=d3d11
//     selects the INTEL part on this machine; the discrete part needs
//     --force_high_performance_gpu. The page's powerPreference:"high-performance"
//     does not reach far enough up the stack to matter.
//
//  4. VSYNC OFF. This is a 120 Hz panel, so a vsync-paced number is quantised
//     to multiples of 8.33 ms and "median 25.0 ms" really means "somewhere in
//     16.7-25.0 ms of work". A contract cannot be written against that.
//
//  5. CONTAMINATION IS COUNTED PER SAMPLE, and it counts chrome.exe — the
//     sibling workflows run headless:false. Own-vs-foreign is resolved by
//     walking the process tree from this node process.
//
// Usage: node tools/trk_modes.mjs --adapter igpu|dgpu [--scene combat|dense]
//                                 [--reps 4] [--secs 2.5] [--clean]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { census } from "./trk_census.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const adapter = flag("--adapter", "igpu");
const reps = Number(flag("--reps", 4));
const secs = Number(flag("--secs", 2.5));
const port = Number(flag("--port", 5282));
const sceneKind = flag("--scene", "combat");
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));

const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const EXPECT = { igpu: /Intel/i, dgpu: /NVIDIA|RTX/i };
const MODES = ["low", "medium", "high"];

// ?test freezes the auto-tuner (autoTuneFrozen) so the mode under test is the
// mode we set and not whatever the tuner's wall-clock window decided. quality=
// high only sets the STARTING mode; the ladder drives it from there.
const url = `http://localhost:${port}/iso.html?test&floor=15&level=26&seed=41&abilities=all&debug=1&quality=high`;

const browser = await chromium.launch({
  headless: false,
  args: [...ADAPTERS[adapter], "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// KEEP-ALIVE FROM THE FIRST SCRIPT THE PAGE RUNS.
//
// A level-26 test crawler dropped straight into floor 15 dies in about three
// seconds — BEFORE readiness polling finishes, let alone before any staging
// code gets a turn. Arming this after load was too late every single time: the
// crawler was already dead, #recap ("IN MEMORIAM") was up, and the ladder spent
// its whole run timing a world rendering behind a full-screen DOM card. The
// scene probe reported `alive:true` because the heal had revived it behind the
// card, which is exactly how the first version of this measurement lied to me.
//
// addInitScript runs before the page's own scripts, so this is armed from the
// first tick and the crawler never dies at all.
// HEALING IS NOT ENOUGH — THE RUN STATUS HAS TO GO BACK TOO. `state.status`
// latches to "wipe" the instant the party is down, the host shows #recap on
// that STATUS EDGE, and topping the HP back up afterwards revives the crawler
// behind a card that never goes away. That is how the first ladder produced a
// full set of healthy-looking numbers for a world rendering underneath IN
// MEMORIAM. Pin the status as well and the edge never fires.
// ...AND THE CARD IS SUPPRESSED OUTRIGHT, because pinning the status is still
// a race. `state.status` latches to "wipe" inside a single step() and the host
// shows #recap on that edge; a 100 ms poll that puts the status back gets there
// after the card is already up, and the card does not leave on its own. Two
// full ladders were thrown away to that race. A stylesheet installed before the
// page's own scripts cannot lose it.
//
// This is measurement scaffolding, not a game change: the question is what a
// GAMEPLAY frame costs, and a frame with a full-screen post-run card over it is
// not one. Nothing in src/ is touched.
// THE INTERVAL IS ARMED FIRST AND THE STYLESHEET IS INJECTED FROM INSIDE IT.
// addInitScript runs before the document exists, so `document.head ||
// document.documentElement` was null and appendChild threw — which silently
// took the heal interval down with it, because it was on the line after. That
// run produced ZERO samples and looked like a worse version of the bug it was
// meant to fix. Nothing here may throw before the interval is scheduled.
await page.addInitScript(() => {
  let styled = false;
  setInterval(() => {
    if (!styled && document.head) {
      styled = true;
      const css = document.createElement("style");
      css.textContent = "#recap{display:none !important}";
      document.head.appendChild(css);
    }
    const s = window.__dcc?.state;
    if (!s?.players) return;
    for (const p of s.players) { p.hp = p.maxHp; p.alive = true; }
    if (s.status !== "playing") s.status = "playing";
  }, 60);
});

/** Any post-run/modal card that would sit over the scene and change the frame. */
const cardUp = () => page.evaluate(() => {
  for (const id of ["recap", "loading", "sheet"]) {
    const e = document.getElementById(id);
    if (!e) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 200 && r.height > 200) return id;
  }
  return null;
});

let out = null;
try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  // READINESS IS NOT data-assets-settled. The boot card runs shader precompile
  // behind it, so the flag can be up while the frame is still multi-second.
  // Poll #loading out, then wait, then assert it has no box at all.
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

  // INSTALLED THROUGH A NAMED FUNCTION SO IT CAN BE RE-INSTALLED.
  //
  // This is a VITE DEV SERVER. Any source edit while the ladder is in flight
  // triggers an HMR reload, `window.__setMode` evaporates, and the run dies
  // twenty minutes in with "not a function" — which is exactly how the first
  // attempt at this measurement ended. Re-installing on demand turns that from
  // a lost run into a logged warning, and the warning matters: a reload means
  // the scene and the shader cache are NOT the ones the earlier samples were
  // taken in, so the run is announced as tainted rather than quietly averaged.
  let reloads = 0;
  const installProbe = () => page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const gl = r3d.renderer;
    const S = { frame: [], update: [], render: [], calls: 0, frames: 0 };
    window.__M = S;
    gl.info.autoReset = false;
    const oU = r3d.update.bind(r3d);
    r3d.update = function (...a) { const t = performance.now(); const r = oU(...a); S.update.push(performance.now() - t); return r; };
    const oR = r3d.render.bind(r3d);
    r3d.render = function (...a) {
      gl.info.reset();
      const t = performance.now(); const r = oR(...a); S.render.push(performance.now() - t);
      S.calls += gl.info.render.calls; S.frames++;
      return r;
    };
    let last = performance.now();
    const tick = () => { const n = performance.now(); S.frame.push(n - last); last = n; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__setMode = (m) => { r3d.setQuality(m); return r3d.qualityProfile.name; };
    // WHAT SCENE IS THIS, ACTUALLY? A frame time means nothing without it, and
    // a key-press recipe is not a scene description — the first run of this
    // ladder produced 5.9 ms on the mode that is supposed to be defending 16.7,
    // because mashing the attack key had simply killed the pack it was meant to
    // be measuring. Density is now measured, not assumed, and it rides along
    // with every sample.
    //
    // `parked` and `nodes` double as the proof that the two free wins are live:
    // parked > 0 means out-of-vision bodies really have left the scene graph,
    // and `nodes` is the number three.js walks per frame (it was 7,566).
    // ---- SCENE CONTROL -----------------------------------------------------
    //
    // WHY THIS EXISTS. A level-26 test crawler dropped into floor 15 and driven
    // by a key-press recipe DIES, every time, within seconds. Every earlier run
    // of this ladder reported `alive:false, hp:0, visible:0` — the harness had
    // spent its whole ladder timing a death screen with all 148 monsters parked
    // out of the scene graph, and calling the result "heavy combat". The frame
    // times were real; they were just frame times for nothing on screen.
    //
    // So the scene is now STAGED rather than stumbled into:
    //   __keepAlive() pins the crawler at full HP on an interval. This is a
    //     RENDERING benchmark — the question is "what does a frame with N
    //     bodies in it cost", and the crawler's survival is scene control, not
    //     a result. Nothing in src/ is touched; this is the harness reaching
    //     into a throwaway ?test session through the ?debug hook.
    //   __toPack() teleports the crawler to the centre of the DENSEST cluster
    //     of live monsters, which is both instant and reproducible — no
    //     wandering and hoping.
    window.__keepAlive = () => {
      if (window.__healT) return;
      window.__healT = setInterval(() => {
        for (const p of window.__dcc.state.players) { p.hp = p.maxHp; p.alive = true; }
      }, 250);
    };
    window.__toPack = () => {
      const s = window.__dcc.state;
      const mobs = s.monsters;
      let bi = -1, bn = -1;
      for (let i = 0; i < mobs.length; i++) {
        let n = 0;
        for (let j = 0; j < mobs.length; j++) {
          const dx = mobs[i].pos.x - mobs[j].pos.x, dy = mobs[i].pos.y - mobs[j].pos.y;
          if (dx * dx + dy * dy <= 36) n++;
        }
        if (n > bn) { bn = n; bi = i; }
      }
      if (bi < 0) return null;
      let cx = 0, cy = 0, n = 0;
      for (const m of mobs) {
        const dx = m.pos.x - mobs[bi].pos.x, dy = m.pos.y - mobs[bi].pos.y;
        if (dx * dx + dy * dy <= 36) { cx += m.pos.x; cy += m.pos.y; n++; }
      }
      const you = s.players[0];
      you.pos.x = cx / n; you.pos.y = cy / n;
      you.hp = you.maxHp; you.alive = true;
      return { packSize: bn, at: [+you.pos.x.toFixed(1), +you.pos.y.toFixed(1)] };
    };
    window.__scene = () => {
      const s = window.__dcc.state;
      let vis = 0, parked = 0;
      for (const [, mesh] of r3d.monsters) { if (mesh.visible) vis++; if (!mesh.parent) parked++; }
      let nodes = 0, skinned = 0, bones = 0;
      r3d.scene.traverse((o) => { nodes++; if (o.isSkinnedMesh) skinned++; if (o.isBone) bones++; });
      const you = s.players.find((p) => p.alive) ?? s.players[0];
      return {
        floor: s.floor, monsters: s.monsters.length, visible: vis, parked,
        nodes, skinned, bones, alive: !!you?.alive, hp: Math.round(you?.hp ?? 0),
      };
    };
    window.__zero = () => { S.frame.length = 0; S.update.length = 0; S.render.length = 0; S.calls = 0; S.frames = 0; };
    window.__dump = () => {
      const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2); };
      const raw = gl.getContext();
      return {
        frames: S.frames,
        // MEAN, EXCLUDING ONLY TRUE STALLS. HIGH on the Intel part measured
        // p50 29.2 against p10 14.9 in the same sample: that spread is not
        // contention, it is the swap chain — rAF queues cheap frames until it
        // fills, then blocks for a long one. The median under-reports what that
        // feels like and p10 badly under-reports it, so throughput is carried
        // as well. 400 ms matches QualityAutoTuner.stallMs: shader builds and
        // tab-switches are not what any mode is being judged on.
        mean: +(S.frame.filter((x) => x < 400).reduce((a, b) => a + b, 0)
          / Math.max(1, S.frame.filter((x) => x < 400).length)).toFixed(2),
        // p10 IS NOT DECORATION — see the contention note in the harvest loop.
        // Foreign CPU load can only ADD to a frame, so the low percentile of a
        // large sample is the best available estimate of the uncontended cost,
        // and it is the statistic that survives a box that is never quiet.
        frame: q(S.frame, 0.5), frame10: q(S.frame, 0.1), frame95: q(S.frame, 0.95),
        update: q(S.update, 0.5), update10: q(S.update, 0.1),
        render: q(S.render, 0.5), render10: q(S.render, 0.1),
        calls: +(S.calls / Math.max(1, S.frames)).toFixed(0),
        buf: [raw.drawingBufferWidth, raw.drawingBufferHeight],
        mode: r3d.qualityProfile.name,
      };
    };
  });
  await installProbe();
  const ensureProbe = async () => {
    if (await page.evaluate(() => typeof window.__setMode === "function")) return;
    reloads++;
    console.log(`!! the page reloaded (HMR?) — re-installing the probe (#${reloads}). `
      + "Samples before and after this line are from DIFFERENT page sessions.");
    await page.waitForFunction(() => !!window.__dcc?.renderer, { timeout: 120000 });
    await page.waitForTimeout(4000);
    await installProbe();
  };

  // ---- STAGE THE SCENE BY MEASURED DENSITY, NOT BY A KEY-PRESS RECIPE ------
  //
  // THE MISTAKE THIS REPLACES. The first version of this harness walked a fixed
  // path and then pressed the attack key every 160 ms for the whole sample. It
  // reported LOW at 5.9 ms and HIGH at 12.0 ms in what it called "heavy
  // combat" — numbers that would have made every contract in quality.ts trivial
  // to meet. They were not heavy combat. A level-26 test crawler with every
  // ability mashing attack six times a second DELETES the pack it is standing
  // in, so the harness spent most of each sample alone in an empty room, and
  // measured that.
  //
  // The scene is now DEFINED BY ITS DENSITY: wander until at least
  // `--minmobs` monsters are simultaneously in vision, and swing only rarely —
  // often enough that hit FX, damage numbers and flashes are live, seldom
  // enough that the pack survives the ladder. Every sample records the density
  // it was taken at, so "the worst real scene" is a claim the JSON can support.
  const minMobs = Number(flag("--minmobs", 14));
  await page.evaluate(() => window.__keepAlive());
  // Walk in so the floor's models/dressing are streamed and resident.
  await page.keyboard.down("w"); await page.waitForTimeout(1600); await page.keyboard.up("w");
  await page.keyboard.down("d"); await page.waitForTimeout(900); await page.keyboard.up("d");
  await page.waitForTimeout(1200);
  console.log(`[scene] before staging: ${JSON.stringify(await page.evaluate(() => window.__scene()))}`);
  let placed = null;
  for (let i = 0; i < 6; i++) {
    placed = await page.evaluate(() => window.__toPack());
    // Fog reveal, aggro, and the mesh pool catching up with what is now nearby.
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => window.__scene());
    console.log(`[scene] attempt ${i + 1}: pack=${placed?.packSize} at ${placed?.at} -> `
      + `visible=${st.visible} alive=${st.alive} nodes=${st.nodes}`);
    if (st.visible >= minMobs) break;
  }
  const staged = await page.evaluate(() => window.__scene());
  console.log(`[scene] STAGED: ${JSON.stringify(staged)}  (target >= ${minMobs} visible)`);
  if (staged.visible < minMobs) {
    console.log(`!! only ${staged.visible} monsters in vision — this run describes a LIGHTER `
      + "scene than intended and its absolutes must not be quoted as a worst case.");
  }
  if (!staged.alive) throw new Error("crawler is dead at staging time — the ladder would time a death screen");
  // AND NOTHING MAY BE COVERING THE SCENE. `alive:true` is not sufficient: the
  // heal revives the crawler BEHIND a post-run card that stays up, and the
  // ladder would then be timing a world rendering underneath a full-screen DOM
  // overlay while every probe reported a healthy dense fight.
  const covered = sceneKind === "dense" ? null : await cardUp();
  if (covered) throw new Error(`#${covered} is covering the scene — this is not a gameplay frame`);

  if (sceneKind === "dense") {
    // FROZEN DENSE: the character sheet pauses the local sim while the renderer
    // keeps drawing the same world. Same pixels, same draws, no drift — the
    // repeatable scene, used to check the ladder's SHAPE is real and not an
    // artifact of a fight going differently three times. It has to come AFTER
    // staging, or there is nothing dense to freeze.
    await page.keyboard.press("p");
    await page.waitForTimeout(1200);
    console.log(`[scene] frozen: ${JSON.stringify(await page.evaluate(() => window.__scene()))}`);
  }

  const acc = new Map(MODES.map((m) => [m, []]));
  let dropped = 0, warmed = false;
  const floor0 = census();
  console.log(`[contamination] foreign browsers right now = ${floor0.foreign}`);

  // MEASURING ON A BOX THAT IS NEVER QUIET.
  //
  // The first plan here was "wait for zero foreign browsers, then run". It does
  // not work on this machine: a sibling workflow has held 11-27 chrome.exe
  // CONTINUOUSLY for hours, and the one attempt to hold a page warm until a
  // clean gap appeared ended with Chromium being killed under the combined
  // memory load. Waiting is not a strategy here, and neither is pretending the
  // contention is not there.
  //
  // So: take every sample, RECORD the foreign count on it, and lean on two
  // things that survive contention.
  //
  //  1. ROTATION + INTERLEAVING. Every mode is sampled in every slot, so
  //     whatever the sibling is doing is charged equally to all three. The
  //     DELTAS and the ORDERING between modes are sound even when the absolute
  //     numbers are inflated. This is the property the previous round relied on
  //     and it is the reason the ladder is interleaved at all.
  //
  //  2. THE LOW PERCENTILE. Foreign CPU load can only ADD to a frame — it never
  //     makes one cheaper. So across a few thousand frames, p10 is the closest
  //     available estimate of what the frame costs when the scheduler is not
  //     stealing the core, and it degrades gracefully: on a genuinely clean box
  //     p10 and p50 converge. Both are reported, always, and the gap between
  //     them is itself the contamination readout.
  //
  // Every sample carries its foreign count into the JSON so the analysis can be
  // redone against the cleanest subset later without re-running anything.
  const deadline = Date.now() + Number(flag("--maxmin", 25)) * 60000;
  const want = reps;
  let closed = false;
  while (Date.now() < deadline && !closed) {
    const need = MODES.map((m) => [m, acc.get(m).length]).sort((a, b) => a[1] - b[1]);
    if (need[0][1] >= want) break;
    const m = need[0][0];
    try {
      await ensureProbe();
      const got = await page.evaluate((mm) => window.__setMode(mm), m);
      if (got !== m) throw new Error(`setQuality("${m}") landed on "${got}"`);
      // Let the resize + buffer reallocation settle before the clock starts.
      await page.waitForTimeout(900);
      const cBefore = census();
      await page.evaluate(() => window.__zero());
      const t0 = Date.now();
      let swings = 0;
      while (Date.now() - t0 < secs * 1000) {
        // ONE swing per ~1.2 s: enough that hit flashes, damage numbers and
        // impact FX are live in every sample, few enough that the pack is still
        // standing when the last mode is measured. See the staging note above
        // for what happens when this is a mash.
        if (sceneKind === "combat" && Date.now() - t0 > swings * 1200) {
          swings++;
          await page.keyboard.press("Space").catch(() => {});
        }
        await page.waitForTimeout(120);
      }
      const d = await page.evaluate(() => window.__dump());
      d.scene = await page.evaluate(() => window.__scene());
      // Re-checked EVERY sample, not just at staging: the crawler can still be
      // overwhelmed mid-ladder, and a sample taken under the recap card is a
      // sample of the recap card.
      const cov = sceneKind === "dense" ? null : await cardUp();
      if (cov) throw new Error(`#${cov} appeared over the scene mid-ladder`);
      if (!d.scene.alive || d.scene.visible < Math.max(4, minMobs >> 1)) {
        throw new Error(`scene collapsed mid-ladder (alive=${d.scene.alive} visible=${d.scene.visible})`);
      }
      const cAfter = census();
      d.foreign = Math.max(cBefore.foreign ?? 99, cAfter.foreign ?? 99);
      d.foreignMoved = cBefore.foreign !== cAfter.foreign;
      if (!warmed) { warmed = true; continue; }   // first sample is warm-up
      acc.get(m).push(d);
      console.log(`  ${m.padEnd(6)} p50=${String(d.frame).padStart(6)} p10=${String(d.frame10).padStart(6)}`
        + ` upd=${String(d.update).padStart(5)}/${d.update10} rnd=${String(d.render).padStart(5)}/${d.render10}`
        + ` calls=${d.calls} vis=${d.scene.visible} parked=${d.scene.parked} nodes=${d.scene.nodes}`
        + ` foreign=${d.foreign}${d.foreignMoved ? "*" : ""} (${acc.get(m).length}/${want})`);
    } catch (e) {
      // Chromium can be killed out from under us on this box. Report what we
      // have rather than losing twenty minutes of samples to an exception.
      console.log(`!! sample aborted (${String(e).split("\n")[0]}) — stopping early`);
      closed = true;
      dropped++;
    }
  }
  const short = MODES.filter((m) => acc.get(m).length < want);
  if (short.length) console.log(`!! short of the requested sample count for: ${short.join(", ")}`);

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[s.length >> 1].toFixed(2) : null; };
  const rows = MODES.map((m) => {
    const rs = acc.get(m);
    return {
      mode: m,
      frameMs: med(rs.map((r) => r.frame)),
      meanMs: med(rs.map((r) => r.mean)),
      frameLowMs: med(rs.map((r) => r.frame10)),
      p95Ms: med(rs.map((r) => r.frame95)),
      updateMs: med(rs.map((r) => r.update)),
      updateLowMs: med(rs.map((r) => r.update10)),
      renderMs: med(rs.map((r) => r.render)),
      renderLowMs: med(rs.map((r) => r.render10)),
      calls: med(rs.map((r) => r.calls)),
      buf: rs[0]?.buf,
      n: rs.length,
      foreignMin: Math.min(...rs.map((r) => r.foreign)),
      foreignMax: Math.max(0, ...rs.map((r) => r.foreign)),
      visible: med(rs.map((r) => r.scene.visible)),
      parked: med(rs.map((r) => r.scene.parked)),
      nodes: med(rs.map((r) => r.scene.nodes)),
      skinned: med(rs.map((r) => r.scene.skinned)),
      bones: med(rs.map((r) => r.scene.bones)),
      monsters: med(rs.map((r) => r.scene.monsters)),
    };
  });
  console.log(`\n=== MODE LADDER · ${adapter.toUpperCase()} · scene=${sceneKind} · ${reps}x${secs}s ===`);
  console.log(`GPU: ${gpu}`);
  console.log("mode        p50      fps     mean     p10   fps10      p95   upd50/10   rnd50/10  calls  n  foreign");
  for (const r of rows) {
    const fps = (v) => (v ? (1000 / v).toFixed(1) : "-");
    console.log(
      r.mode.padEnd(9),
      String(r.frameMs).padStart(6),
      fps(r.frameMs).padStart(8),
      String(r.meanMs).padStart(8),
      String(r.frameLowMs).padStart(7),
      fps(r.frameLowMs).padStart(7),
      String(r.p95Ms).padStart(8),
      `${r.updateMs}/${r.updateLowMs}`.padStart(11),
      `${r.renderMs}/${r.renderLowMs}`.padStart(11),
      String(r.calls).padStart(6),
      String(r.n).padStart(3),
      `${r.foreignMin}-${r.foreignMax}`.padStart(8),
    );
  }
  console.log("\nscene per mode (the thing the numbers are ABOUT):");
  console.log("mode      buffer          mobs  visible  parked   nodes  skinned  bones");
  for (const r of rows) {
    console.log(
      r.mode.padEnd(9), String(r.buf?.join("x")).padEnd(13),
      String(r.monsters).padStart(5), String(r.visible).padStart(8),
      String(r.parked).padStart(7), String(r.nodes).padStart(7),
      String(r.skinned).padStart(8), String(r.bones).padStart(6),
    );
  }
  console.log("\np10 is the contention-robust reading; p50 and p10 converge on a clean box, "
    + "and their gap is the contamination readout.");
  if (reloads) console.log(`!! ${reloads} page reload(s) during this run — treat it as tainted`);
  out = { adapter, gpu, sceneKind, reps, secs, width, height, dpr, reloads, rows, raw: [...acc] };
} finally {
  await browser.close();
}
writeFileSync(`tools/_trkmodes_${adapter}_${sceneKind}.json`, JSON.stringify(out, null, 1));
console.log(`\nwrote tools/_trkmodes_${adapter}_${sceneKind}.json`);
