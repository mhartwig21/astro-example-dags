#!/usr/bin/env node
// tools/audio/verify-r2-loop.mjs — the LOOP WRAP, which is the half of
// SOUNDPLAN §1.4 row E-22 that probe-beds cannot reach. probe-beds resets the
// meters and reads musicSeam() seconds later; the beds are 72-84s long, so its
// window contains no WRAP. `el.loop` on a media element is a decoder
// seek-to-zero and MAY gap, and that is the open question.
//
// This parks on one streamed bed, resets the meter only AFTER the deck reports
// playing (silence before the first start is not a seam — it is why a naive
// reading of musicSeam() showed 210ms), and then watches for 150s: longer than
// the longest bed, so at least one wrap is inside the window.
//
// MACHINE LIMIT: one chromium, launched here, closed here.
// Usage: node tools/audio/verify-r2-loop.mjs [--port 5287]

import { chromium } from "playwright";

const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? process.argv[portArg + 1] : "5287";
// --buffered runs the same window on the pre-r2 decoded path, where the loop
// is an AudioBufferSourceNode and therefore sample-accurate by construction.
// That is the control: if the streamed leg gaps at the wrap and this one does
// not, the gap belongs to el.loop and not to the meter.
const BUFFERED = process.argv.includes("--buffered");
const URL = `http://localhost:${PORT}/iso.html?test&floor=3&level=12&abilities=all&seed=7&debug=1&noassets${BUFFERED ? "&audio=buffered" : ""}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=d3d11", "--force_high_performance_gpu", "--autoplay-policy=no-user-gesture-required"],
});
const out = { samples: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.addInitScript(() =>
    localStorage.setItem("dcc:audio:v1", JSON.stringify({ muted: false, volume: 0.8 })));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el) return true;
    const cs = getComputedStyle(el);
    return el.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
  }, { timeout: 180000 });
  await page.mouse.click(640, 400);
  await page.keyboard.press("]");
  await page.waitForFunction(() => window.__dcc?.audio?.ctxState() === "running", { timeout: 60000 });
  // Park the scene: push every monster out of aggro so the bed does not swap
  // to a battle theme mid-window (a bed change is not a loop wrap).
  await page.waitForFunction(() => {
    const a = window.__dcc.audio;
    return a.streamsStarted().length > 0 || (a.currentMusic() !== null && a.musicEnergy() > 1e-4);
  }, { timeout: 120000 });
  const pin = async () => page.evaluate(() => {
    const s = window.__dcc.state;
    for (const m of s.monsters) { m.pos.x += 400; m.pos.y += 400; }
    const p = s.players[0]; p.maxHp = 999999; p.hp = 999999;
  });
  await pin();
  await sleep(4000);
  await pin();
  const started = await page.evaluate(() => window.__dcc.audio.streamsStarted());
  const bed = await page.evaluate(() => window.__dcc.audio.currentMusic());
  out.bed = bed; out.startedAtReset = started;
  await page.evaluate(() => window.__dcc.audio.resetMusicMeters());
  const t0 = Date.now();
  for (let i = 0; i < 31; i++) {
    await sleep(5000);
    await pin();
    const s = await page.evaluate(() => {
      const a = window.__dcc.audio;
      return {
        music: a.currentMusic(), started: a.streamsStarted(),
        seam: a.musicSeam(), energy: Number(a.musicEnergy().toFixed(5)),
        bufferedSec: Number(a.streamedBufferedSec().toFixed(1)),
        residentPcmBytes: a.residentPcmBytes(),
      };
    });
    out.samples.push({ tSec: Math.round((Date.now() - t0) / 1000), ...s });
  }
  const same = out.samples.every((s) => s.music === bed);
  out.bedHeldThroughout = same;
  out.maxLongestSilentMs = Math.max(...out.samples.map((s) => s.seam?.longestSilentMs ?? -1));
  out.finalBufferedSec = out.samples.at(-1).bufferedSec;
  out.finalResidentPcmBytes = out.samples.at(-1).residentPcmBytes;
} finally {
  await browser.close().catch(() => {});
}
console.log(JSON.stringify(out, null, 2));
