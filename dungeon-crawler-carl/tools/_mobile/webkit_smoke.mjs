// WEBKIT SMOKE — the iPhone/iPad proxy pass (perf-mobile workflow).
//
// One Playwright WEBKIT browser, iPad-class viewport (1180x820, touch).
// Loads /iso.html?test&floor=5&seed=42 on the production preview (5288),
// drives ~60s of play through the touch layer (synthetic pointerType:"touch"
// events into the document-level router; keyboard fallback if the crawler
// does not move), samples rAF deltas + delivered frames/wall-second, and
// harvests EVERY console message, page error and failed request. Also checks
// the ?touchdebug=1 overlay boots. Closes the browser at the end.
//
//   node tools/_mobile/webkit_smoke.mjs [http://localhost:5288]
import { webkit } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:5288";
// Read the expected bundle out of MY dist instead of hardcoding a hash, so a
// rebuild cannot leave this asserting a stale fingerprint (HANDOFF §5).
const BUNDLE = readFileSync(new URL("../../dist/iso.html", import.meta.url), "utf8")
  .match(/iso-[A-Za-z0-9_-]+\.js/)[0];
const out = { checks: [], console: [], pageErrors: [], requestFailures: [], metrics: {} };
const rec = (n, v, det) => { out.checks.push({ name: n, verdict: v, detail: det }); console.error(`[${v}] ${n} — ${det}`); };

const browser = await webkit.launch({ headless: true });
try {
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  const page = await ctx.newPage();

  // ---- harvest channel: every console line, error, failed request
  const tally = new Map();
  page.on("console", (m) => {
    const key = `${m.type()}|${m.text()}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  });
  page.on("pageerror", (e) => out.pageErrors.push(String(e.message ?? e)));
  page.on("requestfailed", (r) =>
    out.requestFailures.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText ?? "?"}`));
  page.on("response", (r) => {
    if (r.status() >= 400) out.requestFailures.push(`HTTP ${r.status()} ${r.url()}`);
  });

  // ---- load + honest boot gate (HARNESS rule 1)
  const t0 = Date.now();
  await page.goto(`${BASE}/iso.html?test&debug=1&touch=1&floor=5&seed=42`,
    { waitUntil: "load", timeout: 120000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  const settledMs = Date.now() - t0;
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
  }, null, { timeout: 240000 });
  const playableMs = Date.now() - t0;
  await page.waitForTimeout(3000);
  const gone = await page.evaluate(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const r = l.getBoundingClientRect();
    const cs = getComputedStyle(l);
    return cs.display === "none" || Number(cs.opacity) === 0 || r.width === 0;
  });
  rec("boot: loading screen fully left", gone ? "PASS" : "FAIL",
    `settled ${settledMs}ms, playable ${playableMs}ms`);
  out.metrics.assetsSettledMs = settledMs;
  out.metrics.playableMs = playableMs;

  // ---- fingerprint the served bundle from inside the page
  const bundles = await page.evaluate(() =>
    [...document.scripts].map((s) => s.src).filter(Boolean).map((s) => s.split("/").pop()));
  rec("fingerprint: iso bundle", bundles.some((b) => b?.includes(BUNDLE)) ? "PASS" : "FAIL",
    `${BUNDLE} :: ${JSON.stringify(bundles)}`);

  // ---- WebGL surface: what did WebKit actually give the game?
  const gl = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    let g = canvas?.getContext("webgl2");
    let version = "webgl2";
    if (!g) { g = canvas?.getContext("webgl"); version = g ? "webgl1" : "none"; }
    if (!g) return { version: "none" };
    const dbg = g.getExtension("WEBGL_debug_renderer_info");
    const want = [
      "EXT_color_buffer_float", "EXT_color_buffer_half_float", "OES_texture_float_linear",
      "EXT_float_blend", "EXT_texture_filter_anisotropic", "KHR_parallel_shader_compile",
      "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_astc", "WEBGL_compressed_texture_etc",
      "EXT_texture_compression_bptc", "WEBGL_multi_draw", "OES_texture_half_float_linear",
    ];
    const have = new Set(g.getSupportedExtensions() ?? []);
    return {
      version,
      renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
      vendor: dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR),
      maxTexture: g.getParameter(g.MAX_TEXTURE_SIZE),
      maxSamples: version === "webgl2" ? g.getParameter(g.MAX_SAMPLES) : 0,
      missing: want.filter((w) => !have.has(w)),
      extCount: have.size,
      contextLost: g.isContextLost(),
    };
  });
  out.metrics.webgl = gl;
  rec("webgl: context is WebGL2", gl.version === "webgl2" ? "PASS" : "FAIL",
    `${gl.version} renderer="${gl.renderer}" vendor="${gl.vendor}" maxTex=${gl.maxTexture} maxSamples=${gl.maxSamples}`);
  rec("webgl: extension gaps", gl.missing?.length ? "WARN" : "PASS",
    `missing: ${JSON.stringify(gl.missing)} (of ${gl.extCount} present)`);

  // ---- audio unlock: a TRUSTED gesture (Playwright keyboard), then ctx state
  const audioBefore = await page.evaluate(() => window.__dcc?.audio?.ctxState() ?? "no-hook");
  await page.keyboard.press("KeyW");
  await page.waitForTimeout(800);
  const audio = await page.evaluate(() => {
    const a = window.__dcc?.audio;
    if (!a) return { state: "no-hook" };
    return {
      state: a.ctxState(),
      residentPcmMB: Math.round(a.residentPcmBytes() / 1048576 * 10) / 10,
      streams: a.streams(),
      streamsStarted: a.streamsStarted(),
      currentMusic: a.currentMusic(),
      playsSoFar: a.plays.length,
    };
  });
  out.metrics.audio = { before: audioBefore, ...audio };
  rec("audio: context running after trusted gesture", audio.state === "running" ? "PASS" : "FAIL",
    `before=${audioBefore} after=${audio.state} music=${audio.currentMusic} streams=${JSON.stringify(audio.streams)}`);

  // ---- touch layer present?
  const zones = await page.evaluate(() => {
    const z = window.__dcc?.touch?.zones;
    if (!z) return null;
    return { anchor: z.stickAnchor, controls: z.controls, preset: z.preset, viewport: z.viewport };
  });
  rec("touch: zone table exists", zones ? "PASS" : "FAIL",
    zones ? `preset=${zones.preset} anchor=${JSON.stringify(zones.anchor)}` : "no zones — touch UI absent");

  // ---- synthetic touch-pointer driver (WebKit has no CDP; the router is an
  // ordinary document-level listener, so constructed PointerEvents exercise it)
  await page.evaluate(() => {
    window.__wkDrive = {
      down(id, x, y) { this._fire("pointerdown", id, x, y); },
      move(id, x, y) { this._fire("pointermove", id, x, y); },
      up(id, x, y) { this._fire("pointerup", id, x, y); },
      _fire(type, id, x, y) {
        const el = document.elementFromPoint(x, y) ?? document.body;
        el.dispatchEvent(new PointerEvent(type, {
          pointerId: id, pointerType: "touch", isPrimary: id === 1,
          clientX: x, clientY: y, bubbles: true, cancelable: true,
          pressure: type === "pointerup" ? 0 : 0.7, width: 20, height: 20,
        }));
      },
    };
  });

  // immortality watchdog so a death cannot end the drive
  const keepAlive = setInterval(() => {
    page.evaluate(() => {
      const p = window.__dcc?.state?.players?.[0];
      if (p) p.hp = Math.max(p.hp, 9000);
    }).catch(() => {});
  }, 800);

  // ---- drivability check: 3s of stick hold, did the crawler move?
  let driveMode = "none";
  if (zones) {
    const A = { x: Math.round(zones.anchor.x), y: Math.round(zones.anchor.y) };
    const p0 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
    await page.evaluate((a) => window.__wkDrive.down(1, a.x, a.y), A);
    for (let i = 0; i < 20; i++) {
      const ang = Math.PI * 0.75;
      await page.evaluate((o) => window.__wkDrive.move(1, o.x, o.y),
        { x: A.x + Math.cos(ang) * 70, y: A.y + Math.sin(ang) * 70 });
      await page.waitForTimeout(120);
    }
    await page.evaluate((a) => window.__wkDrive.up(1, a.x, a.y), A);
    const p1 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
    const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (moved > 0.5) driveMode = "touch";
    rec("touch: synthetic stick moves the crawler", moved > 0.5 ? "PASS" : "FAIL",
      `${moved.toFixed(2)} tiles in ~2.4s`);
  }
  if (driveMode === "none") {
    const p0 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(1500);
    await page.keyboard.up("KeyW");
    const p1 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
    const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (moved > 0.5) driveMode = "keyboard";
    rec("fallback: keyboard moves the crawler", moved > 0.5 ? "PASS" : "FAIL", `${moved.toFixed(2)} tiles`);
  }
  out.metrics.driveMode = driveMode;

  // ---- 60s play with the rAF sampler live
  await page.evaluate(() => {
    const s = { deltas: [], t0: performance.now(), tPrev: performance.now(), frames: 0, running: true, buckets: [] };
    window.__wkPerf = s;
    let bucketStart = s.t0, bucketFrames = 0;
    const loop = (t) => {
      if (!s.running) return;
      s.deltas.push(t - s.tPrev);
      s.tPrev = t;
      s.frames++;
      bucketFrames++;
      if (t - bucketStart >= 1000) { s.buckets.push(bucketFrames); bucketFrames = 0; bucketStart = t; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  const DRIVE_MS = 60000;
  const tDrive = Date.now();
  const chipIds = zones ? Object.keys(zones.controls).filter((k) => /^slot/.test(k)) : [];
  if (driveMode === "touch") {
    const A = { x: Math.round(zones.anchor.x), y: Math.round(zones.anchor.y) };
    await page.evaluate((a) => window.__wkDrive.down(1, a.x, a.y), A);
    let leg = 0;
    while (Date.now() - tDrive < DRIVE_MS) {
      const ang = (leg * Math.PI) / 4;
      const tgt = { x: A.x + Math.cos(ang) * 70, y: A.y + Math.sin(ang) * 70 };
      for (let i = 0; i < 10 && Date.now() - tDrive < DRIVE_MS; i++) {
        await page.evaluate((o) => window.__wkDrive.move(1, o.x, o.y), tgt);
        await page.waitForTimeout(120);
      }
      // every other leg, tap an ability chip with a second finger
      if (leg % 2 === 1 && chipIds.length) {
        const c = zones.controls[chipIds[(leg >> 1) % chipIds.length]];
        const cx = Math.round(c.cx ?? c.x + c.w / 2), cy = Math.round(c.cy ?? c.y + c.h / 2);
        await page.evaluate((o) => window.__wkDrive.down(9, o.x, o.y), { x: cx, y: cy });
        await page.waitForTimeout(90);
        await page.evaluate((o) => window.__wkDrive.up(9, o.x, o.y), { x: cx, y: cy });
      }
      leg++;
    }
    await page.evaluate((a) => window.__wkDrive.up(1, a.x, a.y), A);
  } else {
    const keys = ["KeyW", "KeyA", "KeyS", "KeyD"];
    let leg = 0;
    while (Date.now() - tDrive < DRIVE_MS) {
      const k = keys[leg % 4];
      await page.keyboard.down(k);
      await page.waitForTimeout(1200);
      await page.keyboard.up(k);
      if (leg % 2 === 1) await page.keyboard.press("Digit" + ((leg >> 1) % 4 + 1));
      leg++;
    }
  }

  const perf = await page.evaluate(() => {
    const s = window.__wkPerf;
    s.running = false;
    const wallMs = performance.now() - s.t0;
    const d = [...s.deltas].sort((a, b) => a - b);
    const q = (p) => d[Math.min(d.length - 1, Math.floor(d.length * p))];
    return {
      frames: s.frames, wallMs: Math.round(wallMs),
      fpsDelivered: Math.round((s.frames / wallMs) * 100000) / 100,
      p50: Math.round(q(0.5) * 100) / 100, p95: Math.round(q(0.95) * 100) / 100,
      p99: Math.round(q(0.99) * 100) / 100, max: Math.round(d[d.length - 1] * 100) / 100,
      longFrames50: s.deltas.filter((x) => x > 50).length,
      longFrames100: s.deltas.filter((x) => x > 100).length,
      minBucketFps: Math.min(...s.buckets), buckets: s.buckets,
    };
  });
  out.metrics.frame = perf;
  rec("perf: 60s drive sampled", "INFO",
    `p50=${perf.p50}ms p95=${perf.p95}ms p99=${perf.p99}ms max=${perf.max}ms delivered=${perf.fpsDelivered}fps minSecond=${perf.minBucketFps}fps long>50ms=${perf.longFrames50} long>100ms=${perf.longFrames100}`);

  // ---- post-drive game state sanity + cast verdicts + audio after play
  const post = await page.evaluate(() => {
    const st = window.__dcc.state;
    const a = window.__dcc.audio;
    return {
      floor: st.floor, status: st.status, hp: Math.round(st.players[0].hp),
      pos: st.players[0].pos,
      verdicts: window.__dcc.touch?.verdicts().map((v) => v.kind) ?? [],
      audioState: a.ctxState(), plays: a.plays.length,
      residentPcmMB: Math.round(a.residentPcmBytes() / 1048576 * 10) / 10,
      streams: a.streams(), currentMusic: a.currentMusic(),
      musicEnergy: a.musicEnergy(),
    };
  });
  out.metrics.post = post;
  rec("post-drive: sim alive and on floor 5",
    post.status !== "dead" && post.floor === 5 ? "PASS" : "WARN", JSON.stringify({ ...post, verdicts: undefined }));
  if (driveMode === "touch") {
    rec("touch: chip taps resolved as casts", post.verdicts.length > 0 ? "PASS" : "WARN",
      JSON.stringify(post.verdicts.slice(0, 24)));
  }
  rec("audio: sounds actually played during the drive", post.plays > 0 ? "PASS" : "WARN",
    `${post.plays} plays, music=${post.currentMusic}, energy=${post.musicEnergy?.toFixed?.(3)}, resident PCM ${post.residentPcmMB}MB`);

  clearInterval(keepAlive);

  // ---- ?touchdebug=1 loads
  await page.goto(`${BASE}/iso.html?test&debug=1&touch=1&floor=5&seed=42&touchdebug=1`,
    { waitUntil: "load", timeout: 120000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForTimeout(2500);
  const dbgBoot = await page.evaluate(() => ({
    box: !!document.getElementById("tdbg"),
    head: document.getElementById("tdbg-head")?.textContent ?? null,
  }));
  let dbgLive = null;
  if (dbgBoot.box) {
    await page.evaluate(() => {
      const el = document.elementFromPoint(300, 400) ?? document.body;
      el.dispatchEvent(new PointerEvent("pointerdown", {
        pointerId: 5, pointerType: "touch", isPrimary: true,
        clientX: 300, clientY: 400, bubbles: true, cancelable: true, pressure: 0.7,
      }));
    });
    await page.waitForTimeout(300);
    dbgLive = await page.evaluate(() => ({
      head: document.getElementById("tdbg-head")?.textContent ?? null,
      dots: [...document.querySelectorAll(".tdbg-dot")].filter((d) => d.style.display !== "none").length,
    }));
    await page.evaluate(() => {
      const el = document.elementFromPoint(300, 400) ?? document.body;
      el.dispatchEvent(new PointerEvent("pointerup", {
        pointerId: 5, pointerType: "touch", isPrimary: true,
        clientX: 300, clientY: 400, bubbles: true, cancelable: true, pressure: 0,
      }));
    });
  }
  rec("touchdebug: overlay boots on WebKit", dbgBoot.box ? "PASS" : "FAIL",
    `head=${JSON.stringify(dbgBoot.head)} live=${JSON.stringify(dbgLive)}`);

  // ---- flush console tally
  let builtAfterBoot = 0;
  let prewarmed = null;
  for (const [key, count] of tally) {
    const [type, ...rest] = key.split("|");
    const text = rest.join("|");
    if (text.includes("[shader-guard]") && text.includes("built AFTER boot")) builtAfterBoot += count;
    const m = text.match(/\[shader-guard\] armed: (\d+) programs prewarmed/);
    if (m) prewarmed = Number(m[1]);
    out.console.push({ type, count, text: text.slice(0, 400) });
  }
  // The headline number for opt1-shader-prewarm: every post-boot program build
  // is a mid-play hitch on iPad, where no shader disk cache softens it.
  out.metrics.shaderProgramsPrewarmed = prewarmed;
  out.metrics.shaderProgramsBuiltAfterBoot = builtAfterBoot;
  rec("shader: zero programs built after boot", builtAfterBoot === 0 ? "PASS" : "FAIL",
    `prewarmed=${prewarmed} builtAfterBoot=${builtAfterBoot}`);
} finally {
  await browser.close();
}
console.log("===WEBKIT_SMOKE_JSON===");
console.log(JSON.stringify(out, null, 2));
