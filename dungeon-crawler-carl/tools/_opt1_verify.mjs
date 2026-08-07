// opt1-shader-prewarm verification: tools/_perfprobe2_wf.mjs with two additions —
// (1) programs counted at playable AND at fight end (the "grown during fight" number),
// (2) every [shader-guard] console line harvested per scene.
// Same scenes, same bot, same 4x throttle, ONE browser, closed at the end.
import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "node:fs";

const PORT = 5288;
// Fingerprint: the server on :5288 must be serving MY dist (HANDOFF §5).
const BUNDLE = readFileSync(new URL("../dist/iso.html", import.meta.url), "utf8")
  .match(/iso-[A-Za-z0-9_-]+\.js/)[0];
const servedHtml = await (await fetch(`http://localhost:${PORT}/iso.html`)).text();
if (!servedHtml.includes(BUNDLE)) throw new Error(`fingerprint mismatch: :${PORT} is not serving ${BUNDLE}`);
console.log("[v1] fingerprint OK:", BUNDLE);
const TAG = "dcc-opt1verify-5288";
const scenes = [
  { id: "a_floor2_calm", url: `http://localhost:${PORT}/iso.html?test&floor=2&seed=42&debug=1`, combat: false },
  { id: "b_floor10_combat", url: `http://localhost:${PORT}/iso.html?test&floor=10&level=14&abilities=all&gold=500&seed=42&debug=1`, combat: true },
  { id: "c_floor16_combat", url: `http://localhost:${PORT}/iso.html?test&floor=16&level=14&abilities=all&gold=500&seed=42&debug=1`, combat: true },
];

async function waitPlayable(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector("#loading");
    if (!el) return true;
    const cs = getComputedStyle(el);
    return el.classList.contains("done") || cs.display === "none" || +cs.opacity === 0;
  }, null, { timeout: 300000, polling: 500 });
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.state, null, { timeout: 60000 });
}

async function botTick(page, held, castClock) {
  const st = await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    if (!p) return null;
    p.hp = p.maxHp;
    let best = null, bd = 1e9;
    for (const m of s.monsters) {
      if (m.hp <= 0) continue;
      const dx = m.pos.x - p.pos.x, dy = m.pos.y - p.pos.y, d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = { dx, dy, d }; }
    }
    return { mon: best };
  });
  if (!st) return;
  const want = new Set();
  if (st.mon && st.mon.d > 1.6) {
    if (st.mon.dy < -0.4) want.add("w");
    if (st.mon.dy > 0.4) want.add("s");
    if (st.mon.dx < -0.4) want.add("a");
    if (st.mon.dx > 0.4) want.add("d");
  }
  for (const k of ["w", "a", "s", "d"]) {
    if (want.has(k) && !held.has(k)) { await page.keyboard.down(k); held.add(k); }
    if (!want.has(k) && held.has(k)) { await page.keyboard.up(k); held.delete(k); }
  }
  const now = Date.now();
  const hold = async (key) => { await page.keyboard.down(key); await page.waitForTimeout(250); await page.keyboard.up(key); };
  if (st.mon && st.mon.d < 8) {
    if (now - castClock.basic > 900) { castClock.basic = now; await hold(" "); }
    if (now - castClock.rot > 2100) { castClock.rot = now; await hold(["Shift", "q", "c"][castClock.i++ % 3]); }
    if (now - castClock.ult > 6500) { castClock.ult = now; await hold("f"); }
  }
}

const browser = await chromium.launch({ headless: true, args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", `--${TAG}`] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const out = { _meta: { fingerprint: BUNDLE, at: new Date().toISOString() } };
let guardLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("[shader-guard]")) guardLines.push(t.slice(0, 500));
});
try {
  for (const scene of scenes) {
    console.log("[v1] ===", scene.id);
    guardLines = [];
    out[scene.id] = {};
    const cdp = await ctx.newCDPSession(page);
    await page.goto(scene.url, { waitUntil: "load", timeout: 120000 });
    await waitPlayable(page);
    const progsAtPlayable = await page.evaluate(() => window.__dcc.renderer.renderer.info.programs.length);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const held = new Set(); const castClock = { basic: 0, rot: 0, ult: 0, i: 0 };
    // engage (8s) + draw window (4s) + heap window (15s) = ~27-30s of fight
    const tw = Date.now();
    while (scene.combat && Date.now() - tw < 8000) { await botTick(page, held, castClock); await page.waitForTimeout(400); }

    await page.evaluate(() => {
      const info = window.__dcc.renderer.renderer.info;
      info.autoReset = false;
      info.reset();
      const P = (window.__p2 = { rafs: 0, running: true, f0: info.render.frame });
      const loop = () => { if (!P.running) return; P.rafs++; requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    });
    const dcT0 = Date.now();
    while (Date.now() - dcT0 < 4000) { if (scene.combat) await botTick(page, held, castClock); await page.waitForTimeout(500); }
    const dc = await page.evaluate(() => {
      const info = window.__dcc.renderer.renderer.info;
      window.__p2.running = false;
      const r = { rafs: window.__p2.rafs, renders: info.render.frame - window.__p2.f0,
        calls: info.render.calls, tris: info.render.triangles,
        geoms: info.memory.geometries, tex: info.memory.textures, progs: info.programs.length };
      info.reset(); info.autoReset = true;
      return r;
    });
    const heap = [];
    const hT0 = Date.now();
    let lastBot = 0;
    while (Date.now() - hT0 < 15000) {
      const { usedSize } = await cdp.send("Runtime.getHeapUsage");
      heap.push(usedSize);
      if (scene.combat && Date.now() - lastBot > 900) { lastBot = Date.now(); await botTick(page, held, castClock); }
      await page.waitForTimeout(200);
    }
    for (const k of [...held]) { await page.keyboard.up(k); held.delete(k); }
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const end = await page.evaluate(() => ({
      progs: window.__dcc.renderer.renderer.info.programs.length,
      sweepFires: window.__dcc.renderer.matSweepFires ?? null,
      sweepBuilt: window.__dcc.renderer.matSweepProgramsBuilt ?? null,
      monstersAlive: window.__dcc.state.monsters.filter((m) => m.hp > 0).length,
    }));
    let rise = 0, drops = 0, dropMB = 0;
    for (let i = 1; i < heap.length; i++) {
      const d = heap[i] - heap[i - 1];
      if (d > 0) rise += d; else if (d < -2e6) { drops++; dropMB += -d / 1048576; }
    }
    const res = {
      progsAtPlayable,
      progsAtEnd: end.progs,
      progsGrownDuringFight: end.progs - progsAtPlayable,
      sweepFires: end.sweepFires, sweepBuilt: end.sweepBuilt,
      monstersAlive: end.monstersAlive,
      shaderGuardPostArmBuilds: guardLines.filter((l) => l.includes("built AFTER boot")).length,
      shaderGuardArmed: guardLines.find((l) => l.includes("armed")) ?? null,
      guardLines: guardLines.filter((l) => l.includes("built AFTER boot")),
      callsPerRaf: +(dc.calls / dc.rafs).toFixed(1),
      trisPerRaf: Math.round(dc.tris / dc.rafs),
      rafsIn4s: dc.rafs,
      geoms: dc.geoms, tex: dc.tex, progsAtDcWindow: dc.progs,
      allocRateMBs: +(rise / 1048576 / 15).toFixed(2),
      gcDrops: drops, gcDropTotalMB: +dropMB.toFixed(1),
    };
    out[scene.id] = res;
    console.log(JSON.stringify(res, null, 1));
    await cdp.detach().catch(() => {});
  }
} finally {
  await browser.close();
}
writeFileSync(new URL("./_opt1_verify.out.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("[v1] DONE");
