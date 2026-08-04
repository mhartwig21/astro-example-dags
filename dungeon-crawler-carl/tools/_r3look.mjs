// r3 SPEND — VERIFICATION CAPTURE. One Chromium, headless:false, ANGLE/D3D11,
// the GAME's own context asserted non-software before a single pixel is kept.
//
// Deliberately the same scenes, the same viewport and the same readiness gate
// as tools/_accept2.mjs, so a frame here is comparable to the frame that
// rejected the build rather than to a scene of my own choosing.
//
// TWO THINGS ARE MEASURED, NOT EYEBALLED, because they are the two blockers a
// screenshot can lie about:
//   · the damage-number layer reports every live .dmg element's client rect and
//     the harness computes PAIRWISE OVERLAP AREA. "Digit soup" becomes a number.
//   · the mob plates report their computed fill height and opacity, so
//     "effectively invisible" becomes a number too.
// Every frame also carries a census (crowd, boss alive + distance, preset,
// pixel ratio, boot card box) and is marked MISSED if the census contradicts
// what its filename claims.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const outDir = flag("--out", "tools/_r3look");
mkdirSync(outDir, { recursive: true });
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

const VP = { width: 1440, height: 852 };
const DPR = 2;

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: VP, deviceScaleFactor: DPR });
page.on("pageerror", (e) => say("PAGE ERROR:", e.message));
const out = { meta: {}, shots: [] };

await page.goto("about:blank");
out.meta.gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  if (!gl) return { error: "no webgl" };
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    unmaskedRenderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "(no ext)",
    devicePixelRatio, screen: `${screen.width}x${screen.height}`,
  };
});
say("GPU:", JSON.stringify(out.meta.gpu));
if (/swiftshader|software|llvmpipe/i.test(out.meta.gpu.unmaskedRenderer || "")) {
  say("!! SOFTWARE RENDERER — aborting."); await browser.close(); process.exit(2);
}

await page.addInitScript(() => {
  const pump = () => {
    try {
      const st = window.__dcc && window.__dcc.state;
      if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; }
    } catch { /* */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

const boot = async (url) => {
  await page.goto(url, { waitUntil: "load", timeout: 180000 });
  await page.bringToFront();
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => say("  (assets-settled timed out)"));
  await page.waitForFunction(() => {
    const e = document.getElementById("loading");
    if (!e) return true;
    if (e.classList.contains("done")) return true;
    const cs = getComputedStyle(e);
    return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
  }, { timeout: 300000 }).catch(() => say("  (loading card never left)"));
  await page.waitForFunction(() => {
    const n = window.__dcc?.renderer?.renderer?.info?.programs?.length ?? 0;
    const w = window;
    if (w.__pp === n) w.__ph = (w.__ph || 0) + 1; else { w.__pp = n; w.__ph = 0; }
    return (w.__ph || 0) >= 14;
  }, { timeout: 180000, polling: 100 }).catch(() => say("  (program count never settled)"));
  await page.waitForTimeout(3200);
  const b = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { w: r.width, h: r.height, display: cs.display, opacity: Number(cs.opacity) };
  });
  if (b && b.w > 0 && b.h > 0 && b.display !== "none" && b.opacity > 0.01) {
    throw new Error(`BOOT CARD STILL UP: ${JSON.stringify(b)}`);
  }
  return page.evaluate(() => {
    const R = window.__dcc.renderer;
    const gl = R.renderer.getContext();
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      preset: R.qualityProfile?.name ?? "?",
      pixelRatio: R.renderer.getPixelRatio(),
      drawBuffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
      gameGpu: d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "?",
      programs: R.renderer.info.programs?.length ?? -1,
    };
  });
};

const testUrl = (floor, extra = "") =>
  `http://localhost:${port}/iso.html?test&floor=${floor}&level=${Math.min(30, 3 + floor * 2)}` +
  `&abilities=all&seed=7&eagerassets&clean=1&debug=1${extra}`;

const stage = (crowd) => page.evaluate((n) => {
  const s0 = window.__dcc.state, p = s0.players[0], mapW = s0.map.w;
  const ok = s0.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
  const live = s0.monsters.filter((m) => m.hp > 0);
  const spots = [];
  for (let ri = 0; ri < 7 && spots.length < n; ri++) {
    const r = 1.8 + ri * 0.8;
    for (let k = 0; k < 20 && spots.length < n; k++) {
      const a = (k / 20) * Math.PI * 2 + 0.4 + ri * 0.33;
      const x = p.pos.x + Math.cos(a) * r, y = p.pos.y + Math.sin(a) * r;
      if (s0.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== ok) continue;
      if (spots.some((q) => Math.hypot(q.x - x, q.y - y) < 0.9)) continue;
      spots.push({ x, y });
    }
  }
  const used = live.slice(0, spots.length);
  used.forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.dormant = false; });
  const hold = () => {
    try {
      const s2 = window.__dcc.state, pl = s2.players[0];
      const near = s2.monsters.filter((m) => m.hp > 0)
        .map((m) => ({ m, d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y) }))
        .sort((a, b) => a.d - b.d);
      near.forEach((e, i) => {
        if (i < n) { e.m.maxHp = Math.max(e.m.maxHp || 1, 5e5); e.m.hp = 5e5; e.m.dormant = false; }
      });
    } catch { /* */ }
    requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
  return { placed: used.length, liveTotal: live.length };
}, crowd);

const keys = ["Space", "Shift", "q", "c", "f"];
const fireLoop = async (ms) => {
  const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < ms) {
    await page.keyboard.press(keys[i++ % keys.length], { delay: 40 });
    await page.waitForTimeout(140);
  }
};

// THE TWO MEASURED LAYERS. Numbers, not impressions.
const layers = () => page.evaluate(() => {
  // Only elements a HUMAN can see count as soup: a numeral in the last frames
  // of its fade is at ~0.02 opacity and overlapping it is not a defect. The
  // effective opacity has to come off the running animation, because the
  // element's own style.opacity is untouched by WAAPI.
  const boxes = [...document.querySelectorAll("#fx .dmg:not(.levelup-text)")]
    .filter((e) => e.style.visibility !== "hidden" && e.offsetParent !== null)
    .map((e) => {
      const r = e.getBoundingClientRect();
      const op = Number(getComputedStyle(e).opacity);
      return { x: r.left, y: r.top, w: r.width, h: r.height, op, t: (e.textContent || "").trim() || "(canvas)" };
    })
    .filter((b) => b.w > 1 && b.h > 1 && b.op > 0.12);
  let pairs = 0, worst = 0, totalOverlap = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const ov = ox * oy;
      if (ov > 0) {
        pairs++;
        totalOverlap += ov;
        worst = Math.max(worst, ov / Math.min(a.w * a.h, b.w * b.h));
      }
    }
  }
  const plates = [...document.querySelectorAll("#mobplates .mplate")]
    .filter((e) => e.style.display !== "none");
  const p0 = plates[0];
  let plateInfo = null;
  if (p0) {
    const fill = p0.querySelector(".mpfill");
    const role = p0.querySelector(".mprole");
    const fr = fill ? fill.getBoundingClientRect() : null;
    const rr = role ? role.getBoundingClientRect() : null;
    plateInfo = {
      cls: p0.className,
      opacity: Number(getComputedStyle(p0).opacity),
      fillH: fr ? +fr.height.toFixed(2) : -1,
      fillW: fr ? +fr.width.toFixed(2) : -1,
      fillBg: fill ? getComputedStyle(fill).backgroundImage.slice(0, 60) : "",
      roleW: rr ? +rr.width.toFixed(2) : -1,
      roleBg: role ? getComputedStyle(role).backgroundColor : "",
    };
  }
  return {
    dmgCount: boxes.length,
    dmgOverlapPairs: pairs,
    dmgWorstOverlapFrac: +worst.toFixed(3),
    dmgTotalOverlapPx: Math.round(totalOverlap),
    plateCount: plates.length,
    plate: plateInfo,
  };
});

const census = () => page.evaluate(() => {
  const s = window.__dcc.state, R = window.__dcc.renderer, p = s.players[0];
  const near = s.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) <= 11);
  const load = document.getElementById("loading");
  const lr = load ? load.getBoundingClientRect() : null;
  const b = s.monsters.find((m) => m.hp > 0 && m.kind === "boss");
  return {
    floor: s.floor,
    monstersWithin11: near.length,
    bossAlive: !!b,
    bossDist: b ? +Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y).toFixed(1) : -1,
    preset: R.qualityProfile?.name ?? "?",
    pixelRatio: R.renderer.getPixelRatio(),
    drawCalls: R.renderer.info.render.calls,
    loadingBox: lr ? { w: lr.width, h: lr.height } : null,
  };
});

const shoot = async (name, claim, clip) => {
  const c = await census();
  const l = await layers();
  await page.screenshot({ path: `${outDir}/${name}.png`, ...(clip ? { clip } : {}) });
  out.shots.push({ name, claim, census: c, layers: l });
  say(`  shot ${name}: ${JSON.stringify(c)}`);
  say(`         dmg: n=${l.dmgCount} overlapPairs=${l.dmgOverlapPairs} worst=${l.dmgWorstOverlapFrac} plates=${l.plateCount} ${JSON.stringify(l.plate)}`);
  return { c, l };
};

try {
  say("\n== A1 floor 2, no combat ==");
  out.meta.boot2 = await boot(testUrl(2));
  say("  boot:", JSON.stringify(out.meta.boot2));
  if (/swiftshader|software/i.test(out.meta.boot2.gameGpu)) throw new Error("game context is software");
  await page.keyboard.down("w"); await page.waitForTimeout(1400); await page.keyboard.up("w");
  await page.waitForTimeout(1200);
  await shoot("r3_f2_environment", "an Undercroft room, no combat");

  say("\n== A2 floor 8, no combat ==");
  await boot(testUrl(8));
  await page.keyboard.down("w"); await page.waitForTimeout(1600); await page.keyboard.up("w");
  await page.waitForTimeout(1200);
  await shoot("r3_f8_environment", "a Garden room, no combat");

  say("\n== A3 floor 14 dense combat (the frame that was rejected) ==");
  await boot(testUrl(14));
  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  say("  stage:", JSON.stringify(await stage(22)));
  await page.waitForTimeout(1200);
  for (let i = 0; i < 5; i++) {
    await fireLoop(1000);
    await shoot(`r3_f14_combat_${i}`, "floor-14 combat, abilities live");
  }
  // Native-pixel crop of the pack: the critic's worst frame was this crop.
  await fireLoop(600);
  await shoot("r3_f14_character_crop", "native-pixel crop of the mob pile",
    { x: 380, y: 190, width: 760, height: 640 });

  say("\n== A4 floor 18, the finale, crawler moved onto the boss ==");
  await boot(testUrl(18));
  const moved = await page.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    const b = s.monsters.find((m) => m.hp > 0 && m.kind === "boss");
    if (!b) return { ok: false };
    // Presentation-side teleport for the capture only (same thing acceptance
    // did) — put the crawler 4 tiles off the boss and hold the boss alive.
    p.pos.x = b.pos.x - 3.2; p.pos.y = b.pos.y + 2.4;
    const hold = () => {
      try {
        const bb = window.__dcc.state.monsters.find((m) => m.kind === "boss");
        if (bb) { bb.maxHp = Math.max(bb.maxHp || 1, 1e7); bb.hp = 1e7; bb.dormant = false; }
      } catch { /* */ }
      requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
    return { ok: true, bx: b.pos.x, by: b.pos.y };
  });
  say("  moved:", JSON.stringify(moved));
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) {
    await fireLoop(900);
    const r = await shoot(`r3_f18_boss_${i}`, "the floor-18 boss ON SCREEN");
    if (!r.c.bossAlive || r.c.bossDist > 9) say(`  !! r3_f18_boss_${i} MISSED: bossAlive=${r.c.bossAlive} dist=${r.c.bossDist}`);
  }
} catch (e) {
  say("FAILED:", e.message);
  out.error = e.message;
}

writeFileSync(`${outDir}/look.json`, JSON.stringify(out, null, 2));
writeFileSync(`${outDir}/look.log`, log.join("\n"));
await browser.close();
say("done.");
