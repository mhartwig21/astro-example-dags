#!/usr/bin/env node
// Fingerprint + frame-rate smoke for THE MIX measurement. Read-only.
import { chromium } from "playwright";

const URL = "http://localhost:5291/iso.html?test&floor=15&level=28&abilities=all&gold=800&seed=7&debug=1&noassets";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
  headless: false,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.addInitScript(() => {
    localStorage.setItem("dcc:audio:v1", JSON.stringify({ muted: false, volume: 0.8 }));
    window.__frames = 0;
    const tick = () => { window.__frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), { timeout: 120000 });
  await sleep(2000);
  await page.mouse.click(800, 450);
  await sleep(1500);
  const t0 = await page.evaluate(() => ({ f: window.__frames, e: window.__dcc.state.elapsed, t: performance.now() }));
  await page.keyboard.down(" ");
  await sleep(8000);
  await page.keyboard.up(" ");
  const t1 = await page.evaluate(() => ({
    f: window.__frames, e: window.__dcc.state.elapsed, t: performance.now(),
    plays: window.__dcc.audio.plays.length,
    ids: [...new Set(window.__dcc.audio.plays.map((p) => p.id))],
    skipped: window.__dcc.audio.plays.filter((p) => p.skipped).length,
    throttled: window.__dcc.audio.plays.filter((p) => p.throttled).length,
    buffers: window.__dcc.audio.buffers().length,
    music: window.__dcc.audio.currentMusic(),
    peakPre: window.__dcc.audio.peakPre(),
    peakPost: window.__dcc.audio.peakPost(),
    floor: window.__dcc.state.floor,
    mons: window.__dcc.state.monsters.filter((m) => m.hp > 0).length,
    dom: {
      toasts: !!document.getElementById("toasts"),
      headline: !!document.getElementById("headline"),
      tutorial: !!document.getElementById("tutorial"),
      feed: !!document.getElementById("hud-log-feed"),
      bossbar: !!document.getElementById("bossbar"),
    },
  }));
  const wall = (t1.t - t0.t) / 1000;
  console.log(JSON.stringify({
    wallSec: +wall.toFixed(2),
    simSec: +(t1.e - t0.e).toFixed(2),
    fps: +((t1.f - t0.f) / wall).toFixed(1),
    dilation: +((t1.e - t0.e) / wall).toFixed(3),
    plays: t1.plays, throttled: t1.throttled, skipped: t1.skipped,
    buffers: t1.buffers, music: t1.music,
    peakPre: t1.peakPre, peakPost: t1.peakPost,
    floor: t1.floor, mons: t1.mons, dom: t1.dom,
    ids: t1.ids,
  }, null, 1));
} finally {
  await browser.close();
}
