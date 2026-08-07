#!/usr/bin/env node
/**
 * tools/_mixfilm.mjs — THE FILMSTRIP. The verification pass's read-with-my-own-
 * eyes instrument: contiguous frames through the two moments the mix round
 * exists to protect, each shot paired with the exact DOM composition at the
 * instant of the shutter.
 *
 * Why a strip and not a stack-triggered snapshot (_mixbrowser.mjs's shots):
 * that tool photographs the WORST frame it can find, which answers "how bad
 * does it get". A strip answers a different question — "is the screen legible
 * THROUGH the event", including the frames either side of the peak, where a
 * cap that merely defers the pile would show it arriving late.
 *
 * Two takes:
 *   wipe  — floor 15, sixteen monsters pulled onto the crawler, the strip
 *           centred on a mass death (the density that earned the verdict).
 *   boss  — floor 15 boss woken from dormant with the shutter already running,
 *           so the strip contains the plate's ARRIVAL, not just its steady state.
 *
 * Read-only. Nothing in src/ is touched. ONE browser, closed in a finally.
 * Usage: node tools/_mixfilm.mjs [--out DIR] [--frames N] [--every MS]
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const OUT = arg("--out", "tools/_shots/mixfilm");
const FRAMES = Number(arg("--frames", 10));
const EVERY = Number(arg("--every", 650));
const BASE = "http://localhost:5291/iso.html";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read the glass: every visible overlay element, by zone, with its text. */
function readGlass() {
  const vis = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const zone = (id) => {
    const el = document.getElementById(id);
    if (!el) return [];
    return [...el.children].filter(vis).map((c) => ({
      cls: String(c.className || ""),
      text: (c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 110),
    }));
  };
  const s = window.__dcc && window.__dcc.state;
  const bb = document.getElementById("bossbar");
  const boss = s ? s.monsters.find((m) => m.kind === "boss" && m.hp > 0) : null;
  return {
    t: Math.round(performance.now()),
    elapsed: s ? +s.elapsed.toFixed(2) : -1,
    status: s ? s.status : "?",
    alive: s ? s.monsters.filter((m) => m.hp > 0).length : -1,
    kills: s && s.players[0] ? s.players[0].kills : -1,
    hp: s && s.players[0] ? Math.round(s.players[0].hp) : -1,
    bossbar: vis(bb),
    bossbarText: bb ? (bb.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90) : null,
    bossHpPct: boss ? Math.round((100 * boss.hp) / boss.maxHp) : null,
    bodyCls: document.body.className,
    toasts: zone("toasts"),
    banners: zone("headline"),
    cards: zone("tutorial"),
    callout: (() => {
      const c = document.getElementById("bosscall") || document.querySelector(".bosscall,#boss-callout");
      return c && vis(c) ? (c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) : null;
    })(),
    feedTail: [...document.querySelectorAll("#hud-log-feed > *")].slice(-3).map((e) => (e.textContent || "").trim().slice(0, 70)),
  };
}

async function boot(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), { timeout: 180000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 })
    .catch(() => console.error("  (assets-settled never stamped; continuing)"));
  await sleep(1500);
  await page.mouse.click(800, 450);
  await sleep(800);
}

const strips = {};
const browser = await chromium.launch({
  headless: false,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio",
    "--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.addInitScript(() => localStorage.setItem("dcc:audio:v1", JSON.stringify({ muted: false, volume: 0.8 })));

  // ---------------------------------------------------------------- WIPE ----
  console.error("\n=== TAKE: f15 pack wipe ===");
  await boot(page, `${BASE}?test&floor=15&level=28&abilities=all&gold=800&seed=7&debug=1&eagerassets`);
  await page.evaluate(() => {
    window.__stage = setInterval(() => {
      const s = window.__dcc.state, p = s.players[0];
      if (!p) return;
      p.hp = p.maxHp;
      const want = s.monsters.filter((m) => m.hp > 0).slice(0, 16);
      want.forEach((m, i) => {
        const a = (i / Math.max(1, want.length)) * Math.PI * 2, r = 1.2 + (i % 3) * 0.5;
        m.pos.x = p.pos.x + Math.cos(a) * r;
        m.pos.y = p.pos.y + Math.sin(a) * r;
        m.dormant = false; m.stagger = 0;
        m.attackCooldown = Math.min(m.attackCooldown, 0.2);
      });
    }, 250);
  });
  await page.mouse.move(820, 430);
  await page.keyboard.down(" ");
  await sleep(2500); // let the fight reach steady state before the shutter opens
  {
    const shots = [];
    const KEYS = ["q", "c", "Shift", "f", "e"];
    for (let i = 0; i < FRAMES; i++) {
      const key = KEYS[i % KEYS.length];
      await page.keyboard.down(key);
      await sleep(90);
      await page.keyboard.up(key);
      const g = await page.evaluate(readGlass);
      const name = `wipe_${String(i).padStart(2, "0")}.png`;
      await page.screenshot({ path: join(OUT, name) });
      shots.push({ name, ...g });
      console.error(`  ${name} kills=${g.kills} alive=${g.alive} toasts=${g.toasts.length} banners=${g.banners.length} cards=${g.cards.length} boss=${g.bossbar}`);
      await sleep(Math.max(0, EVERY - 90));
    }
    strips.wipe = shots;
  }
  await page.keyboard.up(" ");
  await page.evaluate(() => clearInterval(window.__stage));

  // ---------------------------------------------------------- BOSS INTRO ----
  console.error("\n=== TAKE: f15 boss intro ===");
  await boot(page, `${BASE}?test&floor=15&level=28&abilities=all&gold=800&seed=7&debug=1&eagerassets`);
  // Park next to the still-DORMANT boss, then open the shutter and wake it, so
  // the strip contains the plate's arrival rather than a fight already running.
  await page.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    const b = s.monsters.find((m) => m.kind === "boss");
    if (b) { p.pos.x = b.pos.x + 2.2; p.pos.y = b.pos.y + 2.2; }
    window.__keepAlive = setInterval(() => {
      const st = window.__dcc.state, pl = st.players[0];
      if (pl) pl.hp = pl.maxHp;
    }, 250);
  });
  await sleep(900);
  {
    const shots = [];
    const KEYS = ["q", "c", "Shift", "f", "e"];
    for (let i = 0; i < FRAMES; i++) {
      if (i === 1) {
        // the wake: the shutter is already running
        await page.evaluate(() => {
          const s = window.__dcc.state;
          const b = s.monsters.find((m) => m.kind === "boss");
          if (b) b.dormant = false;
          for (const m of s.monsters.filter((m) => m.kind !== "boss" && m.hp > 0).slice(0, 6)) m.dormant = false;
        });
        await page.mouse.move(820, 430);
        await page.keyboard.down(" ");
      }
      if (i >= 1) {
        const key = KEYS[i % KEYS.length];
        await page.keyboard.down(key);
        await sleep(90);
        await page.keyboard.up(key);
      }
      const g = await page.evaluate(readGlass);
      const name = `boss_${String(i).padStart(2, "0")}.png`;
      await page.screenshot({ path: join(OUT, name) });
      shots.push({ name, ...g });
      console.error(`  ${name} bossbar=${g.bossbar} bossHp=${g.bossHpPct}% toasts=${g.toasts.length} banners=${g.banners.length} cards=${g.cards.length} body="${g.bodyCls}"`);
      await sleep(Math.max(0, EVERY - 90));
    }
    strips.boss = shots;
  }
  await page.keyboard.up(" ");
  await page.evaluate(() => clearInterval(window.__keepAlive));
} finally {
  await browser.close();
}
writeFileSync(join(OUT, "strip.json"), JSON.stringify(strips, null, 1));
console.error(`\nwrote ${join(OUT, "strip.json")}`);
