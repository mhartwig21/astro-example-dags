// Does the BALANCED rung actually hold 60 fps under VSYNC (i.e. the way a
// player runs)? Walks a few effective pixel ratios via setRenderScale on top of
// the pinned preset and reports vsync-paced throughput for each.
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = flag("--url", "http://localhost:5322/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1&quality=balanced");
const seconds = Number(flag("--seconds", 6));
const reps = Number(flag("--reps", 2));
const scales = flag("--scales", "1,0.96,0.92,0.88").split(",").map(Number);

const browser = await chromium.launch({
  headless: false,
  // VSYNC LEFT ON deliberately: uncapped rAF runs ahead of the GPU and turns
  // the distribution bimodal, which is exactly what we are trying not to
  // measure here. 60 fps means "hits the vsync interval", so pace to it.
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("done") === true, { timeout: 180000 });
await page.waitForTimeout(4000);

const measure = async (s) => page.evaluate((secs) => new Promise((res) => {
  const f = []; let last = performance.now(); const t0 = last;
  const tick = () => {
    const n = performance.now(); f.push(n - last); last = n;
    if (n - t0 < secs * 1000) requestAnimationFrame(tick);
    else {
      const el = n - t0; f.sort((a, b) => a - b);
      res({ mean: +(el / f.length).toFixed(2), fps: +((f.length * 1000) / el).toFixed(1),
        median: +f[Math.floor(f.length / 2)].toFixed(2), p95: +f[Math.floor(f.length * 0.95)].toFixed(2),
        worst: +f[f.length - 1].toFixed(2) });
    }
  };
  requestAnimationFrame(tick);
}), s);

const acc = {};
for (let r = 0; r < reps; r++) {
  for (const sc of scales) {
    const info = await page.evaluate((s) => {
      const R = window.__dcc.renderer;
      R.setRenderScale(s);
      const c = R.renderer.domElement;
      return { pr: +R.renderer.getPixelRatio().toFixed(3), mpx: +((c.width * c.height) / 1e6).toFixed(2) };
    }, sc);
    await page.waitForTimeout(1200);
    for (const k of ["Space", "q", "c"]) await page.keyboard.press(k).catch(() => {});
    const m = await measure(seconds);
    (acc[sc] ||= []).push({ ...m, ...info });
    console.log(`rep${r} scale=${sc} pr=${info.pr} ${info.mpx}Mpx  mean=${m.mean} fps=${m.fps} p95=${m.p95} worst=${m.worst}`);
  }
}
await page.evaluate(() => window.__dcc.renderer.setRenderScale(1));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2); };
console.log("\n--- MEDIAN OF REPS (vsync-paced) ---");
for (const sc of scales) {
  const a = acc[sc];
  console.log(`scale ${sc}  pr=${a[0].pr}  ${a[0].mpx}Mpx  mean=${med(a.map((x) => x.mean))}  fps=${med(a.map((x) => x.fps))}  worst=${med(a.map((x) => x.worst))}`);
}
await browser.close();
