#!/usr/bin/env node
// tools/audio/verify-r2-mem.mjs — the PROCESS-LEVEL memory A/B that SOUNDPLAN
// §1.4 row E-22 says nobody had run. engine.ts's own doc comment on
// residentPcmBytes() is right: on the streamed leg that number is
// self-fulfilling (load() never puts a music id in the map), and it is blind
// to the media elements' decode-ahead. So this measures the OS working set of
// the whole browser process tree on both legs, with everything else held
// identical, and reports the difference.
//
// Attribution: chrome.exe processes are matched by DIFFING the process table
// across the launch, so only processes this script started are counted.
// MACHINE LIMIT: one chromium at a time — launch, sample, close, then the next.
//
// Usage: node tools/audio/verify-r2-mem.mjs [--port 5287]

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? process.argv[portArg + 1] : "5287";
const BASE = `http://localhost:${PORT}/iso.html`;
const TEST = `?test&floor=9&level=12&abilities=all&seed=42&debug=1&noassets`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The browser's processes, and ONLY ours. Two traps, both hit while writing
// this file: (1) `headless: true` in playwright ships the HEADLESS SHELL, so
// the processes are named chrome-headless-shell.exe, not chrome.exe — matching
// on chrome.exe found the OWNER'S OWN Chrome (66 processes, 8.4GB) and would
// have reported its churn as this game's audio memory; (2) an empty process
// query must not read as "no processes". Match on the ms-playwright path, diff
// across the launch, and return null when the table cannot be read.
function browserProcs() {
  for (let i = 0; i < 4; i++) {
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*ms-playwright*' -and ($_.Name -like 'chrome*') } | Select-Object ProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress",
      ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
      if (!out) return [];
      const parsed = JSON.parse(out);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch { /* retry */ }
  }
  return null; // null = MEASUREMENT FAILED, never confused with "none found"
}
const chromeProcs = browserProcs;

async function leg(name, url) {
  const beforeList = chromeProcs();
  if (beforeList === null) throw new Error("process table unreadable before launch");
  const before = new Set(beforeList.map((p) => p.ProcessId));
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-angle=d3d11", "--force_high_performance_gpu", "--autoplay-policy=no-user-gesture-required"],
  });
  const rec = { leg: name, url };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() =>
      localStorage.setItem("dcc:audio:v1", JSON.stringify({ muted: false, volume: 0.8 })));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const el = document.getElementById("loading");
      if (!el) return true;
      const cs = getComputedStyle(el);
      return el.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, { timeout: 180000 });
    await page.mouse.click(640, 400);
    await page.keyboard.press("]");
    await page.waitForFunction(() => window.__dcc?.audio?.ctxState() === "running", { timeout: 60000 });
    // Settle: decode finished (buffered leg) / first bed streaming (default),
    // then 20s of real play so the streamed decks build their read-ahead.
    let last = -1, stable = 0;
    for (let i = 0; i < 360; i++) {
      const v = await page.evaluate(() => window.__dcc.audio.residentPcmBytes());
      if (v === last) { stable += 500; if (stable >= 4000 && v > 0) break; } else { last = v; stable = 0; }
      await sleep(500);
    }
    await sleep(20000);
    rec.engine = await page.evaluate(() => {
      const a = window.__dcc.audio;
      return {
        residentPcmBytes: a.residentPcmBytes(),
        decodedClips: a.buffers().length,
        decodedMusicIds: a.buffers().filter((b) => b.startsWith("music_")).sort(),
        streamsStarted: a.streamsStarted(),
        streamedBufferedSec: Number(a.streamedBufferedSec().toFixed(2)),
        currentMusic: a.currentMusic(),
        musicEnergy: Number(a.musicEnergy().toFixed(6)),
        seam: a.musicSeam(),
        jsHeapUsed: performance.memory?.usedJSHeapSize ?? null,
      };
    });
    const sample = chromeProcs();
    if (sample === null) { rec.process = { error: "process table unreadable at sample time" }; return rec; }
    const mine = sample.filter((p) => !before.has(p.ProcessId));
    rec.process = {
      procs: mine.length,
      chromeProcsSeenTotal: sample.length,
      workingSetBytes: mine.reduce((n, p) => n + Number(p.WorkingSetSize ?? 0), 0),
      perProcess: mine.map((p) => ({ pid: p.ProcessId, ws: Number(p.WorkingSetSize ?? 0),
        type: (/--type=([a-zA-Z-]+)/.exec(p.CommandLine ?? "") ?? [, "browser"])[1] })),
    };
  } finally {
    await browser.close().catch(() => {});
  }
  return rec;
}

const res = [];
res.push(await leg("buffered(pre-r2 baseline)", `${BASE}${TEST}&audio=buffered`));
await sleep(5000);
res.push(await leg("streamed(shipped)", `${BASE}${TEST}`));
console.log(JSON.stringify(res, null, 2));
