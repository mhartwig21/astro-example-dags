// TEMP probe: spawn damage numbers, pause anims like beautyshot, report
// computed opacity/visibility of each .dmg element + ancestor styles.
import { chromium } from "playwright";
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto("http://localhost:5285/iso.html?test&clean=1&debug=1&view=close&floor=6&level=14&seed=77&noassets", { waitUntil: "load" });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 120000 });
await page.waitForTimeout(3000);
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 60000 });
await page.evaluate(() => {
  const dcc = window.__dcc;
  const p = dcc.state.players[0];
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  emit({ pos: { x: p.pos.x + 1, y: p.pos.y }, amount: 168, kind: "crit", dir: { x: 1, y: 0 } });
  emit({ pos: { x: p.pos.x - 1, y: p.pos.y }, amount: 47, kind: "enemy", dir: { x: -1, y: 0 } });
});
await page.waitForTimeout(280);
await page.evaluate(async () => {
  const anims = document.getAnimations();
  for (const a of anims) a.pause();
  await Promise.all(anims.map((a) => a.ready.catch(() => {})));
  for (let pass = 0; pass < 3; pass++) {
    let dirty = false;
    for (const a of anims) {
      const t = a.effect?.getComputedTiming();
      if (!t || !Number.isFinite(t.duration)) continue;
      const wantT = (t.delay ?? 0) + t.duration * 0.35;
      const prog = t.progress;
      if (prog === null || Math.abs(prog - 0.35) > 0.05) {
        a.currentTime = wantT;
        dirty = true;
      }
    }
    if (!dirty) break;
    await new Promise((r) => setTimeout(r, 120));
  }
});
const report = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("#fx .dmg")) {
    const cs = getComputedStyle(el);
    const anims = el.getAnimations().map((a) => ({
      state: a.playState, t: a.currentTime,
      timing: a.effect?.getComputedTiming() ? {
        duration: a.effect.getComputedTiming().duration,
        delay: a.effect.getComputedTiming().delay,
        progress: a.effect.getComputedTiming().progress,
      } : null,
    }));
    out.push({ cls: el.className, styleOpacity: el.style.opacity, computedOpacity: cs.opacity,
      vis: cs.visibility, filter: cs.filter, blend: cs.mixBlendMode, anims });
  }
  const fx = document.getElementById("fx");
  const fxcs = getComputedStyle(fx);
  out.push({ fx: { opacity: fxcs.opacity, filter: fxcs.filter, backdrop: fxcs.backdropFilter, blend: fxcs.mixBlendMode, z: fxcs.zIndex } });
  const cv = document.querySelector("canvas");
  out.push({ canvasZ: cv ? getComputedStyle(cv).zIndex : null, bodyCls: document.body.className });
  return out;
});
console.log(JSON.stringify(report, null, 1));
await browser.close();
