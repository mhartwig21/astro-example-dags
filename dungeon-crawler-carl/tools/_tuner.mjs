// WHERE DOES AUTO-DETECT ACTUALLY LAND, and was the loading screen up when it
// decided? Clears the stored quality choice, boots fresh, then plays for
// --seconds while logging every preset change with the backbuffer size and
// whether #loading was still covering the screen at that moment.
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = flag("--url", "http://localhost:5322/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1&eagerassets");
const seconds = Number(flag("--seconds", 45));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.evaluate(() => { try { localStorage.removeItem("dcc:quality:v1"); } catch { /* blocked */ } });
await page.reload({ waitUntil: "load", timeout: 60000 });

const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("GPU:", gpu);

const t0 = Date.now();
const seen = [];
const snap = async () => page.evaluate(() => {
  const R = window.__dcc?.renderer;
  if (!R) return null;
  const c = R.renderer.domElement;
  const l = document.getElementById("loading");
  return {
    preset: R.qualityProfile.name,
    pixelRatio: +R.renderer.getPixelRatio().toFixed(2),
    mpx: +((c.width * c.height) / 1e6).toFixed(2),
    gtao: R.qualityProfile.gtao,
    loading: !l || l.classList.contains("done") ? "hidden" : "VISIBLE",
  };
});

const deadline = Date.now() + seconds * 1000;
let held = false;
while (Date.now() < deadline) {
  const s = await snap();
  if (s) {
    const last = seen[seen.length - 1];
    if (!last || last.preset !== s.preset || last.loading !== s.loading) {
      seen.push(s);
      console.log(`${String(Date.now() - t0).padStart(6)}ms preset=${s.preset.padEnd(12)} pr=${s.pixelRatio} ${s.mpx}Mpx gtao=${s.gtao} loading=${s.loading}`);
    }
  }
  const el = Date.now() - t0;
  if (el > 12000 && !held) { await page.keyboard.down("w"); held = true; }
  if (el > 20000 && held) { await page.keyboard.up("w"); held = false; }
  if (el > 20000) { for (const k of ["Space", "q", "c"]) await page.keyboard.press(k).catch(() => {}); }
  await page.waitForTimeout(300);
}
const end = await snap();
console.log("END", JSON.stringify(end));
await browser.close();
