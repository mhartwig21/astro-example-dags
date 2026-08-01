// Boot-time A/B. The prewarm in this branch does strictly more work (character
// zoo, two compileAsync passes, a walk of the whole quality ladder), all behind
// the loading screen — so measure what that costs the player in time-to-play.
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const reps = Number(flag("--reps", 3));
const floor = flag("--floor", "8");

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});

async function boot(base) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
  const t0 = Date.now();
  let settled = 0;
  await page.goto(`${base}/iso.html?test&floor=${floor}&level=16&seed=41&abilities=all&eagerassets&debug=1`,
    { waitUntil: "commit", timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 300000 });
  settled = Date.now() - t0;
  // "Playable" = the loading overlay is gone from the layout.
  await page.waitForFunction(() => {
    const el = document.querySelector("#loading, .loading, #loadscreen, [data-loading]");
    if (el) return getComputedStyle(el).display === "none" || el.hidden || !el.isConnected;
    return !!window.__dcc?.state;
  }, null, { timeout: 300000 }).catch(() => {});
  // Renderer is live and composing frames.
  await page.waitForFunction(() => (window.__dcc?.renderer?.frameNo ?? 0) > 30, { timeout: 300000 }).catch(() => {});
  const playable = Date.now() - t0;
  await page.close();
  return { settled, playable };
}

for (const [name, base] of [["SHIPPED(5291)", "http://localhost:5291"], ["MINE(5294)", "http://localhost:5294"]]) {
  const out = [];
  for (let i = 0; i < reps; i++) out.push(await boot(base));
  const med = (k) => out.map((o) => o[k]).sort((a, b) => a - b)[Math.floor(reps / 2)];
  console.log(`${name.padEnd(14)} assetsSettled median ${med("settled")}ms  playable median ${med("playable")}ms  raw=${JSON.stringify(out)}`);
}
await browser.close();
