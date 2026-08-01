// WHEN does the auto-tuner move, and is the player still looking at the
// loading screen when it decides? renderer3d.ts gates the tuner on
// `warmupUntil = firstComposedFrame + 4000`, but prewarm composes frames from
// behind the loading screen, so that 4 s can expire mid-prewarm.
import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const t0 = Date.now();
await page.goto(url, { waitUntil: "load", timeout: 60000 });
let prev = null;
const marks = [];
for (let i = 0; i < 220; i++) {
  const s = await page.evaluate(() => {
    const r = window.__dcc?.renderer;
    const el = document.getElementById("loading");
    return {
      preset: r?.qualityProfile?.name ?? null,
      pr: r?.renderer?.getPixelRatio?.() ?? null,
      mpx: r?.renderer?.domElement ? +((r.renderer.domElement.width * r.renderer.domElement.height) / 1e6).toFixed(2) : null,
      loading: el ? (el.classList.contains("done") || getComputedStyle(el).display === "none" ? "hidden" : "VISIBLE") : "gone",
      programs: r?.renderer?.info?.programs?.length ?? null,
    };
  }).catch(() => null);
  if (s && s.preset) {
    const key = `${s.preset}|${s.loading}`;
    if (key !== prev) { marks.push({ t: Date.now() - t0, ...s }); prev = key; }
  }
  await page.waitForTimeout(150);
}
console.log("PRESET / LOADING-SCREEN TIMELINE (changes only):");
for (const m of marks) console.log(`  ${String(m.t).padStart(6)}ms  preset=${String(m.preset).padEnd(12)} pixelRatio=${m.pr}  ${String(m.mpx).padStart(5)}Mpx  loadingScreen=${m.loading}  programs=${m.programs}`);
await browser.close();
