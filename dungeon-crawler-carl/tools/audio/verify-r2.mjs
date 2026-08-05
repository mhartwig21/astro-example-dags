#!/usr/bin/env node
// tools/audio/verify-r2.mjs — the audio r2 FINAL VERIFICATION instrument.
// Three questions SOUNDPLAN §1.4 rows E-21/E-22 left measured-by-nobody:
//
//   a. MEMORY      — resident decoded PCM AND process-level memory, on BOTH
//                    legs (?audio=buffered vs the streamed default). The
//                    engine's own doc comment says residentPcmBytes() alone is
//                    self-fulfilling; the A/B and the OS process tree are not.
//   b. BOOT PAYLOAD— audio bytes on the wire before the game is playable,
//                    from CDP Network.loadingFinished encodedDataLength.
//   c. EVERY CAST  — drive all 16 AbilityId members through the REAL sim
//                    (__dcc.step with a slot cast) and read the engine's play
//                    ring for the cue, including throttle/skip reasons.
//
// MACHINE LIMIT (owner's dev box): exactly ONE chromium at a time. This file
// launches, measures, CLOSES, then launches the next leg. Never two.
//
// Usage: node tools/audio/verify-r2.mjs [--port 5287]

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? process.argv[portArg + 1] : "5287";
const BASE = `http://localhost:${PORT}/iso.html`;
const TEST = `?test&floor=9&level=12&abilities=all&seed=42&debug=1&noassets`;

const ARGS = [
  "--use-angle=d3d11",
  "--force_high_performance_gpu",
  "--autoplay-policy=no-user-gesture-required",
];

const ROSTER = [
  "melee", "dash", "bolt", "nova", "orbit", "stance", "overcharge",
  "cutto", "crowdsurf", "stuntdouble", "bulwark", "cables",
  "airstrike", "cataclysm", "bullettime", "injunction",
];
const EXPECT = {
  melee: "swing", dash: "cast_dash", bolt: "bolt", nova: "nova",
  orbit: "cast_orbit", stance: "cast_stance", overcharge: "cast_overcharge",
  cutto: "cast_cutto", crowdsurf: "cast_crowdsurf", stuntdouble: "cast_stuntdouble",
  bulwark: "cast_bulwark", cables: "cast_cables", airstrike: "cast_airstrike",
  cataclysm: "cast_cataclysm", bullettime: "cast_bullettime", injunction: "cast_injunction",
};

// ---- OS process-tree memory (the honest instrument E-22 asks for) ----------
function snapshotProcs() {
  const out = execFileSync("powershell", [
    "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress",
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}
function treeMemory(rootPid) {
  const rows = snapshotProcs();
  const byParent = new Map();
  for (const r of rows) {
    if (!byParent.has(r.ParentProcessId)) byParent.set(r.ParentProcessId, []);
    byParent.get(r.ParentProcessId).push(r);
  }
  const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
  const seen = new Set();
  const stack = [rootPid];
  const members = [];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = byPid.get(pid);
    if (self) members.push(self);
    for (const c of byParent.get(pid) ?? []) stack.push(c.ProcessId);
  }
  // Only the browser processes: playwright spawns chrome.exe as a child of
  // THIS node process, so the tree root is us and node's own heap is excluded.
  const chrome = members.filter((m) => /^chrome\.exe$/i.test(m.Name ?? ""));
  const ws = chrome.reduce((n, m) => n + Number(m.WorkingSetSize ?? 0), 0);
  const priv = chrome.reduce((n, m) => n + Number(m.PrivatePageCount ?? 0) * 4096, 0);
  return { chromeProcs: chrome.length, workingSetBytes: ws, privateBytes: priv,
           top: chrome.map((m) => ({ pid: m.ProcessId, ws: Number(m.WorkingSetSize ?? 0) }))
             .sort((a, b) => b.ws - a.ws).slice(0, 5) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function leg(name, url, { casts = false } = {}) {
  const browser = await chromium.launch({ headless: true, args: ARGS });
  const rec = { leg: name, url };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => console.error(`[pageerror:${name}]`, e.message));
    await page.addInitScript(() =>
      localStorage.setItem("dcc:audio:v1", JSON.stringify({ muted: false, volume: 0.8 })));

    // ---- b. BOOT PAYLOAD via CDP -----------------------------------------
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    const urls = new Map();
    const finished = []; // {url, bytes, t}
    cdp.on("Network.requestWillBeSent", (e) => urls.set(e.requestId, e.request.url));
    cdp.on("Network.loadingFinished", (e) => {
      finished.push({ url: urls.get(e.requestId) ?? "?", bytes: e.encodedDataLength, t: Date.now() });
    });

    const t0 = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // "playable" = the boot card is done (same gate probe-beds uses).
    await page.waitForFunction(() => {
      const el = document.getElementById("loading");
      if (!el) return true;
      const cs = getComputedStyle(el);
      return el.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, { timeout: 180000 });
    const tGate = Date.now();
    // Unlock exactly the way a player does (gesture), then let the decode
    // path settle: the buffered leg has 27 minutes of music to decode.
    await page.mouse.click(640, 400);
    await page.keyboard.press("]");
    await page.waitForFunction(() => {
      const a = window.__dcc?.audio;
      return !!a && a.ctxState() === "running";
    }, { timeout: 60000 }).catch(() => {});
    // Wait for residentPcmBytes to stop moving (decode finished), max 180s.
    let last = -1, stableFor = 0;
    for (let i = 0; i < 360; i++) {
      const v = await page.evaluate(() => window.__dcc?.audio?.residentPcmBytes() ?? 0);
      if (v === last) { stableFor += 500; if (stableFor >= 4000 && v > 0) break; }
      else { last = v; stableFor = 0; }
      await sleep(500);
    }
    const tSettled = Date.now();

    const audioAt = (cut) => {
      const rows = finished.filter((f) => f.url.includes("/audio/") && f.t <= cut);
      const music = rows.filter((f) => f.url.includes("/audio/music/"));
      const sfx = rows.filter((f) => !f.url.includes("/audio/music/"));
      const sum = (a) => a.reduce((n, f) => n + f.bytes, 0);
      return { files: rows.length, bytes: sum(rows),
               musicFiles: music.length, musicBytes: sum(music),
               sfxFiles: sfx.length, sfxBytes: sum(sfx) };
    };
    rec.timing = { bootGateMs: tGate - t0, settledMs: tSettled - t0 };
    rec.payloadAtBootGate = audioAt(tGate);
    rec.payloadAtSettle = audioAt(tSettled);

    // ---- a. MEMORY --------------------------------------------------------
    await sleep(3000);
    rec.engine = await page.evaluate(() => {
      const a = window.__dcc.audio;
      return {
        residentPcmBytes: a.residentPcmBytes(),
        decodedClips: a.buffers().length,
        decodedMusicIds: a.buffers().filter((b) => b.startsWith("music_")).sort(),
        streams: a.streams(),
        streamsStarted: a.streamsStarted(),
        streamedBufferedSec: Number(a.streamedBufferedSec().toFixed(2)),
        currentMusic: a.currentMusic(),
        musicEnergy: Number(a.musicEnergy().toFixed(6)),
        ctx: a.ctxState(),
        jsHeap: performance.memory ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
        } : null,
      };
    });
    rec.process = treeMemory(process.pid);
    rec.perfMetrics = Object.fromEntries(
      (await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }))).metrics
        ?.filter((m) => /Heap|Nodes|Documents/.test(m.name)).map((m) => [m.name, m.value]) ?? []);

    // ---- c. EVERY CAST FIRES ---------------------------------------------
    if (casts) {
      rec.casts = [];
      for (const ab of ROSTER) {
        const row = await page.evaluate(async (ability) => {
          const sleepp = (ms) => new Promise((r) => setTimeout(r, ms));
          const a = window.__dcc.audio;
          const s = window.__dcc.state;
          const p = s.players[0];
          // Stage: alive, ability slotted + ranked, cooldown clear, charges
          // full, no channel in progress, and a live body 4 tiles ahead (the
          // targeted casts return early without one).
          p.alive = true; p.hp = p.maxHp = Math.max(p.maxHp, 9999);
          p.downedT = 0; p.barrageT = 0; p.rootT = 0;
          p.facing = { x: 1, y: 0 };
          p.abilities.ranks[ability] = Math.max(1, p.abilities.ranks[ability] ?? 0);
          p.abilities.slots[0] = ability;
          p.cd[ability] = 0;
          p.dashCharges = Math.max(1, p.dashCharges ?? 1);
          if (p.cutCharges !== undefined) p.cutCharges = Math.max(1, p.cutCharges);
          const near = s.monsters.filter((m) => m.hp > 0).slice(0, 3);
          near.forEach((m, i) => {
            m.pos.x = p.pos.x + 4 + i * 0.6; m.pos.y = p.pos.y + i * 0.4;
            m.hp = Math.max(m.hp, 500); m.maxHp = Math.max(m.maxHp, 500);
          });
          const mark = performance.now();
          window.__dcc.step({ [p.id]: {
            move: { x: 0, y: 0 }, useStairs: false, aim: { x: 1, y: 0 },
            cast: [true, false, false, false, false],
          } }, 0.016);
          const castT = p.cd[ability] ?? 0;
          const chargesAfter = { dash: p.dashCharges, cut: p.cutCharges };
          const swings = p.attackSwing;
          await sleepp(1600); // several host frames: the director diffs per frame
          const fresh = a.plays.filter((r) => r.at >= mark);
          return { ability, cooldownAfterCast: Number(castT.toFixed(3)),
                   chargesAfter, swings, ring: fresh.map((r) => ({
                     id: r.id, gain: Number(r.gain.toFixed(3)),
                     throttled: !!r.throttled, skipped: r.skipped ?? null })) };
        }, ab);
        row.expected = EXPECT[ab];
        const hit = row.ring.find((r) => r.id === row.expected && !r.throttled && !r.skipped);
        const any = row.ring.find((r) => r.id === row.expected);
        row.fired = !!hit;
        row.note = hit ? "" : any ? (any.throttled ? "THROTTLED" : `SKIPPED:${any.skipped}`) : "no ring entry";
        rec.casts.push(row);
        await sleep(400);
      }
      rec.headroom = await page.evaluate(() => ({
        peakCompressorIn: Number(window.__dcc.audio.peakPre().toFixed(3)),
        peakCompressorOut: Number(window.__dcc.audio.peakPost().toFixed(3)),
      }));
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return rec;
}

const results = [];
// Baseline leg FIRST (?audio=buffered = the pre-r2 all-decoded path), then the
// shipped streamed leg with the cast drive. Sequential: one browser, ever.
results.push(await leg("buffered(baseline)", `${BASE}${TEST}&audio=buffered`));
await sleep(2000);
results.push(await leg("streamed(shipped)", `${BASE}${TEST}`, { casts: true }));

console.log(JSON.stringify(results, null, 2));
