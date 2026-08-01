// QUALITY-LADDER STATE DUMP. Not a timing tool — it answers "what did the
// preset ladder actually DO?" on a real GPU at the real display size: which
// preset auto-detect chose, what the pixel ratio ended up as, how big every
// post buffer is, and which passes are live. Use it to verify a preset before
// trusting any number measured under it.
//
// Usage: node tools/qstate.mjs [url] [--preset ultra|high|balanced|performance]
//                              [--w 1440] [--h 852] [--dpr 2]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http")
  ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const preset = flag("--preset", "");
const width = Number(flag("--w", 1440));
const height = Number(flag("--h", 852));
const dpr = Number(flag("--dpr", 2));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(4000);

if (preset) await page.evaluate((p) => window.__dcc.renderer.setQuality(p), preset);

const state = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const q = R.qualityProfile;
  return {
    machine: { cores: navigator.hardwareConcurrency, devicePixelRatio },
    choice: R.qualitySetting,
    preset: q.name,
    profile: q,
    effectivePixelRatio: gl.getPixelRatio(),
    backbuffer: [gl.domElement.width, gl.domElement.height],
    megapixels: +((gl.domElement.width * gl.domElement.height) / 1e6).toFixed(2),
    composerRT: {
      size: [R.composer.renderTarget1.width, R.composer.renderTarget1.height],
      samples: R.composer.renderTarget1.samples,
      hasDepthTexture: !!R.composer.renderTarget1.depthTexture,
    },
    gtao: {
      enabled: R.gtao.enabled,
      ao: [R.gtao.gtaoRenderTarget.width, R.gtao.gtaoRenderTarget.height],
      denoise: [R.gtao.pdRenderTarget.width, R.gtao.pdRenderTarget.height],
      normalRT: [R.gtao.normalRenderTarget.width, R.gtao.normalRenderTarget.height],
    },
    bloom: {
      enabled: R.bloom.enabled,
      mip0: [R.bloom.renderTargetsHorizontal[0].width, R.bloom.renderTargetsHorizontal[0].height],
    },
    shadow: { enabled: gl.shadowMap.enabled, autoUpdate: gl.shadowMap.autoUpdate, map: R.key.shadow.mapSize.x },
    lights: { fxPool: R.fxLights.length, torchPool: R.torchPool.length },
    passes: R.composer.passes.map((p) => p.constructor.name + (p.enabled ? "" : " (OFF)")),
    programs: gl.info.programs.length,
  };
});

console.log(JSON.stringify(state, null, 1));
await browser.close();
