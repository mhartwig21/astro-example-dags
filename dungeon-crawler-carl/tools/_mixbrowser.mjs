#!/usr/bin/env node
/**
 * tools/_mixbrowser.mjs — THE MIX, half two: the SHIPPING build, measured
 * through the glass. Read-only; nothing in src/ is modified.
 *
 * What only the browser can say:
 *  - VOICES: every BaseAudioContext buffer source that actually starts, with
 *    its buffer duration and playback rate (concurrency, for real clips).
 *  - The engine's own ring (window.__dcc.audio.plays): ids, gains, and the
 *    throttled attempts the spam guard swallowed.
 *  - Headroom: peakPre (compressor input) / peakPost (output).
 *  - NOTIFICATIONS off the glass: a MutationObserver over #toasts, #headline,
 *    #tutorial and #hud-log-feed gives every line's kind, text, arrival and
 *    removal — so simultaneity and screen-occupancy are measured, not derived
 *    from the router's intent.
 *  - Whether a boss bar / death beat is on screen while unrelated lines are.
 *
 * The clock: headless SwiftShader runs the sim at ~0.15x wall time, which
 * would fabricate a calm mix (the engine's throttle is wall-clock). So this
 * runs HEADED on d3d11 and reports the measured dilation with every rate;
 * rates are quoted per SIM second, sampled per frame.
 *
 * Usage: node tools/_mixbrowser.mjs [--out DIR] [--seconds N]
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const OUT = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "tools/_shots/mix";
const SECONDS = argv.includes("--seconds") ? Number(argv[argv.indexOf("--seconds") + 1]) : 30;
const BASE = "http://localhost:5291/iso.html";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS = [
  { name: "f03_pack", floor: 3, level: 5, kind: "pack", pull: 8 },
  { name: "f15_pack", floor: 15, level: 28, kind: "pack", pull: 16 },
  { name: "f17_pack", floor: 17, level: 32, kind: "pack", pull: 16 },
  { name: "f13_pack", floor: 13, level: 24, kind: "pack", pull: 14 },
  { name: "f15_elite", floor: 15, level: 28, kind: "elite", pull: 10 },
  { name: "f15_boss", floor: 15, level: 28, kind: "boss", pull: 0 },
];

function initScript() {
  window.__mix = { voices: [], nodes: [], frames: [], t0: performance.now() };
  const M = window.__mix;
  const proto = (window.BaseAudioContext || window.AudioContext).prototype;
  const orig = proto.createBufferSource;
  proto.createBufferSource = function () {
    const node = orig.call(this);
    const start = node.start.bind(node);
    node.start = function (...a) {
      try {
        M.voices.push({
          at: performance.now(),
          dur: node.buffer ? node.buffer.duration : 0,
          rate: node.playbackRate ? node.playbackRate.value : 1,
        });
      } catch { /* ignore */ }
      return start(...a);
    };
    return node;
  };

  const ZONES = { toasts: "toast", headline: "banner", tutorial: "card", "hud-log-feed": "feed" };
  const watched = new Map();
  const arm = () => {
    for (const [id, zone] of Object.entries(ZONES)) {
      if (watched.has(id)) continue;
      const el = document.getElementById(id);
      if (!el) continue;
      const live = new Map();
      const obs = new MutationObserver((muts) => {
        const t = performance.now();
        for (const mu of muts) {
          for (const n of mu.addedNodes) {
            if (n.nodeType !== 1) continue;
            const cls = String(n.className || "");
            const rec = {
              zone, cls,
              kind: (cls.match(/toast-([a-z]+)/) || [])[1] || null,
              text: (n.textContent || "").slice(0, 120),
              add: t, rm: null,
            };
            live.set(n, rec);
            M.nodes.push(rec);
          }
          for (const n of mu.removedNodes) {
            const rec = live.get(n);
            if (rec) { rec.rm = t; live.delete(n); }
          }
        }
      });
      obs.observe(el, { childList: true });
      watched.set(id, { el, obs, live });
    }
  };
  const vis = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const kids = (id) => {
    const el = document.getElementById(id);
    if (!el) return 0;
    let n = 0;
    for (const c of el.children) if (vis(c)) n++;
    return n;
  };
  const tick = () => {
    arm();
    const s = window.__dcc && window.__dcc.state;
    const toasts = kids("toasts"), banners = kids("headline"), cards = kids("tutorial");
    M.frames.push({
      t: performance.now(),
      e: s ? s.elapsed : -1,
      floor: s ? s.floor : -1,
      dead: !!(s && s.status === "dead"),
      boss: vis(document.getElementById("bossbar")),
      toasts, banners, cards,
      feed: kids("hud-log-feed"),
      alive: s ? s.monsters.filter((m) => m.hp > 0).length : -1,
    });
    window.__mixStack = toasts + banners + cards;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function boot(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), { timeout: 180000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 })
    .catch(() => console.error("  (assets-settled never stamped; continuing)"));
  await sleep(1500);
  await page.mouse.click(800, 450);
  await sleep(800);
  await page.evaluate(() => { void window.__dcc.audio.plays.length; });
  await page.evaluate(() => { window.__mix.voices.length = 0; window.__mix.nodes.length = 0; window.__mix.frames.length = 0; });
}

const results = {};
const browser = await chromium.launch({
  headless: false,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio",
    "--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.addInitScript(() => localStorage.setItem("dcc:audio:v1", JSON.stringify({ muted: false, volume: 0.8 })));
  await page.addInitScript(initScript);

  for (const sc of SCENARIOS) {
    console.error(`\n=== ${sc.name} ===`);
    await boot(page, `${BASE}?test&floor=${sc.floor}&level=${sc.level}&abilities=all&gold=800&seed=7&debug=1&eagerassets`);
    await page.evaluate(() => window.__dcc.audio.resetPeaks());
    await page.evaluate((sc) => {
      const S = () => window.__dcc.state;
      window.__stage = setInterval(() => {
        const s = S();
        if (!s || !s.players[0]) return;
        const p = s.players[0];
        p.hp = p.maxHp;
        if (sc.kind === "boss") {
          const b = s.monsters.find((m) => m.kind === "boss" && m.hp > 0);
          if (b) {
            b.dormant = false;
            if (Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) > 4) { p.pos.x = b.pos.x + 1.6; p.pos.y = b.pos.y + 1.6; }
          }
          for (const m of s.monsters.filter((m) => m.kind !== "boss" && m.hp > 0).slice(0, 6)) m.dormant = false;
          return;
        }
        const want = s.monsters
          .filter((m) => m.hp > 0 && (sc.kind !== "elite" || m.elite || m.affix || m.veteran))
          .slice(0, sc.pull);
        want.forEach((m, i) => {
          const a = (i / Math.max(1, want.length)) * Math.PI * 2;
          const r = 1.2 + (i % 3) * 0.5;
          m.pos.x = p.pos.x + Math.cos(a) * r;
          m.pos.y = p.pos.y + Math.sin(a) * r;
          m.dormant = false; m.stagger = 0;
          m.attackCooldown = Math.min(m.attackCooldown, 0.2);
        });
      }, 250);
    }, sc);

    // fight: hold attack, rotate abilities; shoot the worst stacks as they happen
    await page.mouse.move(820, 430);
    await page.keyboard.down(" ");
    const KEYS = ["q", "c", "Shift", "f", "e"];
    const t0 = Date.now();
    let k = 0, best = 0, shots = 0;
    while (Date.now() - t0 < SECONDS * 1000) {
      const key = KEYS[k++ % KEYS.length];
      await page.keyboard.down(key);
      await sleep(260);
      await page.keyboard.up(key);
      const stack = await page.evaluate(() => window.__mixStack || 0);
      if (stack > best && stack >= 3 && shots < 3) {
        best = stack; shots++;
        await page.screenshot({ path: join(OUT, `${sc.name}_stack${stack}_${shots}.png`) });
        console.error(`  shot stack=${stack}`);
      }
      await sleep(240);
    }
    await page.keyboard.up(" ");
    await page.evaluate(() => clearInterval(window.__stage));
    await sleep(400);

    const data = await page.evaluate(() => ({
      voices: window.__mix.voices,
      nodes: window.__mix.nodes,
      frames: window.__mix.frames,
      plays: window.__dcc.audio.plays.map((p) => ({ id: p.id, at: p.at, gain: p.gain, throttled: !!p.throttled, skipped: p.skipped || null })),
      peakPre: window.__dcc.audio.peakPre(),
      peakPost: window.__dcc.audio.peakPost(),
      music: window.__dcc.audio.currentMusic(),
      floor: window.__dcc.state.floor,
      elapsed: window.__dcc.state.elapsed,
      status: window.__dcc.state.status,
      kills: window.__dcc.state.players[0].kills,
    }));
    results[sc.name] = { scenario: sc, ...data };
    const f = data.frames;
    const wall = f.length ? (f[f.length - 1].t - f[0].t) / 1000 : 0;
    const sim = f.length ? f[f.length - 1].e - f[0].e : 0;
    console.error(`  fps=${(f.length / wall).toFixed(1)} dilation=${(sim / wall).toFixed(2)} plays=${data.plays.length} voices=${data.voices.length} lines=${data.nodes.length} peakPre=${data.peakPre.toFixed(3)} peakPost=${data.peakPost.toFixed(3)} music=${data.music}`);
  }

  // ---- deliberate climax captures: boss bar under toast pressure, and death
  for (const shot of ["boss", "death"]) {
    console.error(`\n=== climax shot ${shot} ===`);
    await boot(page, `${BASE}?test&floor=15&level=28&abilities=all&gold=800&seed=7&debug=1&eagerassets`);
    await page.evaluate((mode) => {
      const s = window.__dcc.state;
      const p = s.players[0];
      if (mode === "boss") {
        const b = s.monsters.find((m) => m.kind === "boss");
        if (b) { p.pos.x = b.pos.x + 2; p.pos.y = b.pos.y + 2; b.dormant = false; }
      }
      window.__hold = setInterval(() => {
        const st = window.__dcc.state, pl = st.players[0];
        if (mode === "boss") { pl.hp = pl.maxHp; }
        for (const m of st.monsters.filter((m) => m.hp > 0).slice(0, 10)) m.dormant = false;
      }, 300);
    }, shot);
    await page.mouse.move(820, 430);
    await page.keyboard.down(" ");
    await sleep(12000);
    await page.keyboard.up(" ");
    if (shot === "death") {
      await page.evaluate(() => {
        clearInterval(window.__hold);
        const s = window.__dcc.state, p = s.players[0];
        p.hp = 1;
        for (const m of s.monsters.filter((m) => m.hp > 0).slice(0, 12)) {
          m.pos.x = p.pos.x + (m.id % 3) * 0.4 - 0.4;
          m.pos.y = p.pos.y + (m.id % 5) * 0.3 - 0.6;
          m.dormant = false; m.attackCooldown = 0;
        }
      });
      await page.keyboard.down(" ");
      await sleep(6000);
      await page.keyboard.up(" ");
    }
    await page.evaluate(() => { try { window.__dcc.hold(20); } catch { /* */ } });
    await sleep(300);
    await page.screenshot({ path: join(OUT, `climax_${shot}.png`) });
    const snap = await page.evaluate(() => ({
      toasts: [...document.querySelectorAll("#toasts > *")].map((e) => e.textContent),
      banners: [...document.querySelectorAll("#headline > *")].map((e) => e.textContent),
      cards: [...document.querySelectorAll("#tutorial > *")].map((e) => (e.textContent || "").slice(0, 100)),
      feed: [...document.querySelectorAll("#hud-log-feed > *")].slice(-10).map((e) => e.textContent),
      bossbar: (() => { const b = document.getElementById("bossbar"); return b ? getComputedStyle(b).display !== "none" : false; })(),
      status: window.__dcc.state.status,
      nodes: window.__mix.nodes,
      frames: window.__mix.frames,
    }));
    results[`climax_${shot}`] = snap;
    console.error(`  bossbar=${snap.bossbar} status=${snap.status} toasts=${snap.toasts.length} banners=${snap.banners.length} cards=${snap.cards.length}`);
    try { await page.evaluate(() => clearInterval(window.__hold)); } catch { /* */ }
  }
} finally {
  await browser.close();
}
writeFileSync(join(OUT, "raw.json"), JSON.stringify(results));
console.error(`\nwrote ${join(OUT, "raw.json")}`);
