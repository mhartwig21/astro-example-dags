// WHAT IS WASHING THE FRAME — one identical cast, one subsystem removed.
//
// Two earlier cuts of this tool each answered a different question than the one
// asked, so this one is deliberately expensive: EVERY condition reloads the
// page and replays the SAME staging and the SAME key sequence from the same
// seed, so the frames across conditions are the same moment of the same fight
// with one thing missing. Anything cheaper compares different moments and
// invites exactly the kind of confident wrong conclusion this is here to avoid.
//
// One Chromium, headless:false, ANGLE/D3D11, game-context renderer asserted.
// Score the output with: node tools/coloraudit.mjs tools/_wash
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = flag("--port", "5282");
const outDir = flag("--out", "tools/_wash");
mkdirSync(outDir, { recursive: true });
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => say("PAGE ERROR:", e.message));
await page.addInitScript(() => {
  const pump = () => {
    try { const st = window.__dcc && window.__dcc.state; if (st && st.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; } } catch { /* */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

const URL = `http://localhost:${port}/iso.html?test&floor=17&level=30&abilities=all&seed=41&eagerassets&clean=1&debug=1&quality=performance`;

async function ready() {
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => {});
  await page.waitForFunction(() => {
    const e = document.getElementById("loading");
    if (!e) return true;
    if (e.classList.contains("done")) return true;
    const cs = getComputedStyle(e);
    return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
  }, { timeout: 300000 }).catch(() => {});
  await page.waitForFunction(() => {
    const n = window.__dcc?.renderer?.renderer?.info?.programs?.length ?? 0;
    const w = window;
    if (w.__pp === n) w.__ph = (w.__ph || 0) + 1; else { w.__pp = n; w.__ph = 0; }
    return (w.__ph || 0) >= 12;
  }, { timeout: 120000, polling: 100 }).catch(() => {});
  await page.waitForTimeout(3000);
  const box = await page.evaluate(() => {
    const e = document.getElementById("loading");
    if (!e) return null;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { w: r.width, h: r.height, display: cs.display, opacity: Number(cs.opacity) };
  });
  return !(box && box.w > 0 && box.h > 0 && box.display !== "none" && box.opacity > 0.01);
}

const stage = () => page.evaluate(() => {
  const st = window.__dcc.state, p = st.players[0], mapW = st.map.w;
  const ok = st.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
  const live = st.monsters.filter((m) => m.hp > 0);
  const spots = [];
  for (let ri = 0; ri < 5 && spots.length < 18; ri++) {
    const r = 1.7 + ri * 0.85;
    for (let k = 0; k < 18 && spots.length < 18; k++) {
      const a = (k / 18) * Math.PI * 2 + 0.4 + ri * 0.33;
      const x = p.pos.x + Math.cos(a) * r, y = p.pos.y + Math.sin(a) * r;
      if (st.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== ok) continue;
      spots.push({ x, y });
    }
  }
  live.slice(0, spots.length).forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.dormant = false; });
  const pump = () => {
    try { for (const m of window.__dcc.state.monsters) { m.maxHp = Math.max(m.maxHp || 0, 1e7); m.hp = 1e7; } } catch { /* */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

let gpuSaid = false;

async function run(name, setup) {
  await page.goto(URL, { waitUntil: "load", timeout: 120000 });
  await page.bringToFront();
  if (!(await ready())) { say(`${name}: BOOT CARD STILL UP — MISSED`); return; }
  if (!gpuSaid) {
    const gpu = await page.evaluate(() => {
      const ctx = window.__dcc.renderer.renderer.getContext();
      const d = ctx.getExtension("WEBGL_debug_renderer_info");
      return d ? String(ctx.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "unknown";
    });
    say("GAME CONTEXT GPU:", gpu);
    if (/SwiftShader|Software|llvmpipe/i.test(gpu)) { say("REFUSING: software GL"); await browser.close(); process.exit(1); }
    gpuSaid = true;
  }
  await page.keyboard.down("w"); await page.waitForTimeout(1600); await page.keyboard.up("w");
  await stage();
  await page.waitForTimeout(1500);
  await page.evaluate(setup);
  await page.waitForTimeout(300);
  // The identical burst, every time: the ultimate then four follow-ups.
  const KEYS = ["f", "Space", "Shift", "q", "c", "Space"];
  for (let i = 0; i < KEYS.length; i++) {
    await page.keyboard.press(KEYS[i], { delay: 30 });
    await page.waitForTimeout(110);
    await page.screenshot({ path: `${outDir}/${name}_${String(i).padStart(2, "0")}.png` });
  }
  say(`${name}: ${KEYS.length} frames`);
}

// Each setup installs a rAF pump so the removal survives the whole burst.
const hide = (expr) => `(() => { const R = window.__dcc.renderer; const f = () => { try { ${expr} } catch (e) {} requestAnimationFrame(f); }; requestAnimationFrame(f); })()`;

await run("A_asis", "(() => {})()");
await run("B_noaoe", hide("R.aoe.group.visible = false;"));
await run("C_notelegraph", hide("for (const g of R.telegraphs.values()) g.visible = false;"));
await run("D_nofxlights", hide("for (const s of R.fxLights) { s.light.visible = false; s.light.intensity = 0; }"));
await run("E_nobloom", hide("R.bloom.enabled = false;"));
await run("F_nofxp", hide("R.fxp.group.visible = false;"));

writeFileSync(`${outDir}/wash.log`, log.join("\n"));
await browser.close();
say("done.");
