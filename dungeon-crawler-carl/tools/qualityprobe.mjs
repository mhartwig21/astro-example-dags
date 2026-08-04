// QUALITY PRESET PROBE — "is the preset a phone picks actually sane?"
//
// The capture harness pins `quality=performance` so SwiftShader can keep up,
// which means it can never answer this question. This loads the page with NO
// quality override on each real device descriptor and reads back what
// guessQuality() actually chose, plus the backbuffer it sized.
//
// LIMIT, STATED UP FRONT: this is Chromium-under-emulation, not Safari. The
// whole point of the mobile branch is that Safari does not expose
// WEBGL_debug_renderer_info; a Chromium emulating an iPhone still does. What
// this DOES verify is the coarse-pointer/short-edge path, which is the branch
// that fires first and does not depend on the extension at all.
import { chromium, devices } from "playwright";

const BASE = process.env.DCC_BASE ?? "http://localhost:5370";
const LIST = [
  ["iPhone 13 landscape", "iphone13-land"],
  ["iPhone 13 Pro Max landscape", "iphone13promax-land"],
  ["iPad (gen 7) landscape", "ipad7-land"],
  ["iPad Pro 11 landscape", "ipadpro11-land"],
  ["Pixel 5 landscape", "pixel5-land"],
  ["Desktop Chrome", "desktop"],
];

const browser = await chromium.launch();
const rows = [];
for (const [pw, label] of LIST) {
  const desc = devices[pw];
  const ctx = await browser.newContext(
    desc ? { ...desc, hasTouch: true, isMobile: true } : {},
  );
  const page = await ctx.newPage();
  try {
    // No `quality=` in the URL: this is the whole point.
    await page.goto(`${BASE}/iso.html?test&debug=1&eagerassets&floor=1&seed=7`,
      { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => !!(window.__dcc && window.__dcc.renderer),
      null, { timeout: 180000 });
    const q = await page.evaluate(() => {
      const r = window.__dcc.renderer;
      const gl = r.renderer;
      return {
        preset: r.quality?.name ?? null,
        choice: r.qualityChoice ?? null,
        pixelRatioCap: r.quality?.pixelRatioCap ?? null,
        dpr: devicePixelRatio,
        vp: { w: innerWidth, h: innerHeight },
        shortEdge: Math.min(screen.width, screen.height),
        coarse: matchMedia("(pointer: coarse)").matches,
        uiclass: document.body.dataset.uiclass ?? null,
        backbuffer: gl.domElement
          ? { w: gl.domElement.width, h: gl.domElement.height }
          : null,
      };
    });
    rows.push({ device: label, ...q });
    console.log(label.padEnd(22),
      `preset=${String(q.preset).padEnd(12)} cap=${String(q.pixelRatioCap).padEnd(5)}`,
      `dpr=${q.dpr} vp=${q.vp.w}x${q.vp.h} short=${q.shortEdge} coarse=${q.coarse}`,
      `uiclass=${q.uiclass}`,
      q.backbuffer ? `backbuffer=${q.backbuffer.w}x${q.backbuffer.h}` : "");
  } catch (e) {
    console.log(label.padEnd(22), "FAILED", e.message.slice(0, 120));
    rows.push({ device: label, error: e.message });
  }
  await ctx.close();
}
await browser.close();
console.log("\n" + JSON.stringify(rows, null, 2));
