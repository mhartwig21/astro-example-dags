// Does a preset switch produce a DARK FRAME?
//
// applyQuality() disposes key.shadow.map and sets it to null whenever
// shadowMapSize changes. render() only re-arms shadowMap.needsUpdate on frames
// where frameNo % shadowInterval === 0, so on the presets with a cadence > 1 the
// world can compose with light.shadow.map === null. three.js then binds its 1x1
// emptyTexture for directionalShadowMap, the PCF compare returns 0, and the key
// light is fully occluded for that frame.
//
// Measured here as mean luminance of the composed canvas on NULL-map frames vs
// the frames either side of them.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const base = flag("--base", "http://localhost:5294");
const out = flag("--out", "tools/_shadowflash");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
let armed = false;
page.on("console", (m) => { if (m.text().includes("shader-guard] armed")) armed = true; });
await page.goto(`${base}/iso.html?test&floor=5&level=18&seed=41&abilities=all&debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
for (let i = 0; i < 120 && !armed; i++) await page.waitForTimeout(500);
await page.waitForTimeout(2000);

const res = await page.evaluate(async () => {
  const r = window.__dcc.renderer;
  const gl = r.renderer.getContext();
  const W = 160, H = 96;
  // Read a downsampled strip straight out of the default framebuffer right
  // after the composed frame, before the browser presents it.
  const buf = new Uint8Array(W * H * 4);
  const samples = [];
  const orig = r.render.bind(r);
  r.render = function () {
    orig();
    const cw = r.renderer.domElement.width, ch = r.renderer.domElement.height;
    // Sample a centred WxH block of the real backbuffer.
    const x0 = Math.max(0, ((cw - W) / 2) | 0), y0 = Math.max(0, ((ch - H) / 2) | 0);
    r.renderer.setRenderTarget(null);
    gl.readPixels(x0, y0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let lum = 0;
    for (let i = 0; i < buf.length; i += 4) lum += 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
    samples.push({ lum: +(lum / (W * H)).toFixed(2), map: r.key.shadow.map ? r.key.shadow.map.width : 0, preset: r.quality.name });
  };
  const nextFrame = () => new Promise((res2) => requestAnimationFrame(() => requestAnimationFrame(res2)));
  r.setQuality("ultra");
  for (let i = 0; i < 6; i++) await nextFrame();          // settle
  const order = ["balanced", "performance", "ultra", "high"];
  for (let i = 0; i < 24; i++) { r.setQuality(order[i % 4]); for (let k = 0; k < 3; k++) await nextFrame(); }
  r.render = orig;
  return samples;
});

const withMap = res.filter((s) => s.map > 0).map((s) => s.lum);
const noMap = res.filter((s) => s.map === 0).map((s) => s.lum);
const mean = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null;
console.log(`frames=${res.length}  NULL-map frames=${noMap.length}`);
console.log(`mean luminance WITH shadow map : ${mean(withMap)}   (n=${withMap.length})`);
console.log(`mean luminance NULL shadow map : ${mean(noMap)}   (n=${noMap.length})`);
if (mean(noMap) !== null && mean(withMap) !== null) {
  const drop = (1 - mean(noMap) / mean(withMap)) * 100;
  console.log(`=> NULL-map frames are ${drop.toFixed(1)}% ${drop > 0 ? "DARKER" : "brighter"}`);
}
console.log("first 30 frames:", JSON.stringify(res.slice(0, 30)));
writeFileSync(`${out}/samples.json`, JSON.stringify(res, null, 1));
await browser.close();
