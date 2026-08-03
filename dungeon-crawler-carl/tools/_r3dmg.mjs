// WHICH numbers are overlapping, and by how much — the residual after the
// swept-box reservation. Dumps the offending PAIR (text, rect, opacity, scale)
// rather than a summary statistic, because the summary is what let two wrong
// theories through already. One Chromium, floor 14, the same staged pull.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const port = "5282";
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const log = [];
const say = (...a) => { const s = a.join(" "); console.log(s); log.push(s); };
page.on("pageerror", (e) => say("PAGE ERROR:", e.message));
await page.addInitScript(() => {
  const pump = () => {
    try { const st = window.__dcc?.state; if (st?.players) for (const p of st.players) { p.maxHp = 1e9; p.hp = 1e9; } } catch { /* */ }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
});

await page.goto(`http://localhost:${port}/iso.html?test&floor=14&level=30&abilities=all&seed=7&eagerassets&clean=1&debug=1`, { waitUntil: "load", timeout: 180000 });
await page.bringToFront();
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => {
  const e = document.getElementById("loading");
  if (!e) return true;
  if (e.classList.contains("done")) return true;
  const cs = getComputedStyle(e);
  return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0;
}, { timeout: 300000 }).catch(() => {});
await page.waitForTimeout(3200);
say("gpu:", await page.evaluate(() => {
  const gl = window.__dcc.renderer.renderer.getContext();
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : "?";
}));

await page.keyboard.down("w"); await page.waitForTimeout(1500); await page.keyboard.up("w");
await page.evaluate(() => {
  const s0 = window.__dcc.state, p = s0.players[0], mapW = s0.map.w;
  const ok = s0.map.tiles[Math.floor(p.pos.y) * mapW + Math.floor(p.pos.x)];
  const live = s0.monsters.filter((m) => m.hp > 0);
  const spots = [];
  for (let ri = 0; ri < 7 && spots.length < 22; ri++) {
    const r = 1.8 + ri * 0.8;
    for (let k = 0; k < 20 && spots.length < 22; k++) {
      const a = (k / 20) * Math.PI * 2 + 0.4 + ri * 0.33;
      const x = p.pos.x + Math.cos(a) * r, y = p.pos.y + Math.sin(a) * r;
      if (s0.map.tiles[Math.floor(y) * mapW + Math.floor(x)] !== ok) continue;
      spots.push({ x, y });
    }
  }
  live.slice(0, spots.length).forEach((m, k) => { m.pos.x = spots[k].x; m.pos.y = spots[k].y; m.dormant = false; });
  const hold = () => {
    try { for (const m of window.__dcc.state.monsters) if (m.hp > 0) { m.maxHp = Math.max(m.maxHp || 1, 5e5); m.hp = 5e5; } } catch { /* */ }
    requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
});
await page.waitForTimeout(1200);

await page.evaluate(() => {
  window.__worst = [];
  const scan = () => {
    const boxes = [...document.querySelectorAll("#fx .dmg:not(.levelup-text)")]
      .filter((e) => e.style.visibility !== "hidden" && e.offsetParent !== null)
      .map((e) => {
        const r = e.getBoundingClientRect();
        const cv = e.firstElementChild;
        return {
          x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
          op: +Number(getComputedStyle(e).opacity).toFixed(2),
          cls: e.className,
          cw: cv && cv.tagName === "CANVAS" ? cv.width : -1,
          ch: cv && cv.tagName === "CANVAS" ? cv.height : -1,
          tf: getComputedStyle(e).transform.slice(0, 44),
        };
      })
      .filter((b) => b.w > 1 && b.h > 1 && b.op > 0.12);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const ov = ox * oy;
        if (ov <= 0) continue;
        const frac = ov / Math.min(a.w * a.h, b.w * b.h);
        window.__worst.push({ frac: +frac.toFixed(3), n: boxes.length, a, b });
      }
    }
    if (window.__worst.length > 400) window.__worst.length = 400;
    requestAnimationFrame(scan);
  };
  requestAnimationFrame(scan);
});

const keys = ["Space", "Shift", "q", "c", "f"];
for (let i = 0; i < 60; i++) { await page.keyboard.press(keys[i % keys.length], { delay: 40 }); await page.waitForTimeout(180); }

const worst = await page.evaluate(() => window.__worst.sort((p, q) => q.frac - p.frac).slice(0, 14));
say(`pairs recorded: ${(await page.evaluate(() => window.__worst.length))}`);
for (const w of worst) say(JSON.stringify(w));
writeFileSync("tools/_r3dmg.log", log.join("\n"));
await browser.close();
