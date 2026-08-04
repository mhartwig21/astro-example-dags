// VISUAL PROOF FOR THE THREE MODES.
//
// The two big changes behind this round are invisible when they work and
// catastrophic when they do not:
//   - out-of-vision bodies are REMOVED from the scene graph (not just hidden),
//   - off-screen rigs animate at a reduced rate.
// A frame time cannot tell the difference between "cheaper" and "the monsters
// stopped being drawn", so this takes the picture.
//
// It also captures the SYSTEM panel row, because "player-visible and persisted"
// is a claim that should have a screenshot behind it too.
//
// Usage: node tools/trk_modeshots.mjs [--adapter igpu|dgpu] [--port 5282]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const adapter = flag("--adapter", "igpu");
const port = Number(flag("--port", 5282));
const OUT = "tools/_r4shots";
mkdirSync(OUT, { recursive: true });

const ADAPTERS = {
  igpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
  dgpu: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu"],
};
const url = `http://localhost:${port}/iso.html?test&floor=15&level=26&seed=41&abilities=all&debug=1&eagerassets&quality=high`;

const browser = await chromium.launch({
  headless: false,
  args: [...ADAPTERS[adapter], "--enable-gpu-rasterization"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

// Same scene control as tools/trk_modes.mjs, and for the same reason: a
// level-26 test crawler dropped into floor 15 dies in about three seconds, and
// the first version of these screenshots was five identical pictures of the
// IN MEMORIAM card. See the long note in trk_modes.mjs.
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

try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 });
  await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 300000 });
  await page.waitForTimeout(3500);

  const gpu = await page.evaluate(() => {
    const gl = window.__dcc.renderer.renderer.getContext();
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  console.log("GPU:", gpu);

  await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
  await page.evaluate(() => {
    const s = window.__dcc.state, mobs = s.monsters;
    let bi = -1, bn = -1;
    for (let i = 0; i < mobs.length; i++) {
      let n = 0;
      for (let j = 0; j < mobs.length; j++) {
        const dx = mobs[i].pos.x - mobs[j].pos.x, dy = mobs[i].pos.y - mobs[j].pos.y;
        if (dx * dx + dy * dy <= 36) n++;
      }
      if (n > bn) { bn = n; bi = i; }
    }
    let cx = 0, cy = 0, n = 0;
    for (const m of mobs) {
      const dx = m.pos.x - mobs[bi].pos.x, dy = m.pos.y - mobs[bi].pos.y;
      if (dx * dx + dy * dy <= 36) { cx += m.pos.x; cy += m.pos.y; n++; }
    }
    const you = s.players[0];
    you.pos.x = cx / n; you.pos.y = cy / n; you.hp = you.maxHp; you.alive = true;
  });
  await page.waitForTimeout(3000);

  for (const mode of ["low", "medium", "high"]) {
    await page.evaluate((m) => window.__dcc.renderer.setQuality(m), mode);
    await page.waitForTimeout(2200);
    const st = await page.evaluate(() => {
      const r3d = window.__dcc.renderer, s = window.__dcc.state;
      let vis = 0, parked = 0, drawn = 0;
      for (const [, mesh] of r3d.monsters) {
        if (mesh.visible) vis++;
        if (!mesh.parent) parked++;
        if (mesh.visible && mesh.parent) drawn++;
      }
      const raw = r3d.renderer.getContext();
      return {
        mode: r3d.qualityProfile.name, monsters: s.monsters.length,
        visible: vis, parked, drawn, alive: s.players[0].alive,
        buf: `${raw.drawingBufferWidth}x${raw.drawingBufferHeight}`,
      };
    });
    console.log(`${mode.padEnd(7)} ${JSON.stringify(st)}`);
    // EVERY VISIBLE BODY MUST BE IN THE GRAPH. This is the assertion that
    // parking is a performance change and not a rendering change.
    if (st.drawn !== st.visible) throw new Error(`${mode}: ${st.visible} visible but only ${st.drawn} in the scene graph`);
    if (!st.alive) throw new Error(`${mode}: crawler is dead — this is a picture of the post-run card`);
    const card = await page.evaluate(() => {
      const e = document.getElementById("recap");
      const r = e?.getBoundingClientRect();
      return r && r.width > 200 && r.height > 200;
    });
    if (card) throw new Error(`${mode}: #recap is covering the scene`);
    await page.screenshot({ path: `${OUT}/${adapter}_${mode}.png` });
  }

  // The settings row itself. It lives on the CONTROLS tab, not KEY BINDINGS —
  // it is a setting, not a rebindable key — so the tab has to be selected or
  // the screenshot is of the wrong page.
  await page.keyboard.press("k");
  await page.waitForTimeout(1000);
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll("[data-kbtab]")].map((e) => e.dataset.kbtab));
  console.log("kb tabs:", JSON.stringify(tabs));
  for (const t of tabs) {
    await page.evaluate((tt) => {
      document.querySelector(`[data-kbtab="${tt}"]`)?.click();
    }, t);
    await page.waitForTimeout(600);
    const vis = await page.evaluate(() => {
      const e = document.getElementById("kb-perfmode");
      const r = e?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    });
    if (vis) { console.log(`performance-mode row is on tab "${t}"`); break; }
  }
  // It sits with the other graphics setting (Render scale), below the key list,
  // so the panel has to be scrolled for the screenshot to show anything.
  await page.evaluate(() => document.getElementById("kb-perfmode")
    ?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(600);
  const row = await page.evaluate(() => ({
    key: document.getElementById("kb-perfmode")?.textContent,
    note: document.getElementById("kb-perfmode-note")?.textContent,
  }));
  console.log("SYSTEM row:", JSON.stringify(row));
  await page.screenshot({ path: `${OUT}/${adapter}_settings.png` });

  // Click it once and prove it cycles + persists.
  await page.click("#kb-perfmode");
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    key: document.getElementById("kb-perfmode")?.textContent,
    stored: localStorage.getItem("dcc:quality:v2"),
    live: window.__dcc.renderer.qualityProfile.name,
  }));
  console.log("after one click:", JSON.stringify(after));
  await page.screenshot({ path: `${OUT}/${adapter}_settings_clicked.png` });
} finally {
  await browser.close();
}
console.log(`\nwrote ${OUT}/`);
