// ROUND 5 ACCEPTANCE CRITIC — independent capture, written from scratch.
// Plays real runs against a real server (clean DB on :5451), photographs the
// ten seconds after a run ends, and MEASURES panel fit rather than eyeballing it.
//
//   node tools/_critic5.mjs                 death on the daily contract
//   SCENARIO=win node tools/_critic5.mjs    a CLEAR (the rarest screen)
//   SCENARIO=boards node tools/_critic5.mjs standings + career, no run
//   SCENARIO=fit node tools/_critic5.mjs    overflow measurement, 4 viewports
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "tools/_critic5";
const API = process.env.API ?? "http://localhost:5451";
const SCENARIO = process.env.SCENARIO ?? "death";
const W = Number(process.env.W ?? 1600), H = Number(process.env.H ?? 900);
const BASE = `http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`;
mkdirSync(OUT, { recursive: true });

// A believable local career: 34 runs, so the grade has a comparison set and
// the "graded against" line has something honest to say.
const HISTORY = [];
for (let i = 0; i < 34; i++) {
  const floor = [2, 4, 3, 5, 6, 5, 7, 8, 6, 9, 10, 7, 11, 12, 9, 13, 15, 11, 18, 8][i % 20];
  const w = ((i * 2654435761) % 1009) / 1009;
  HISTORY.push({
    endedAt: Date.now() - (i + 1) * 3600_000 * 6 - Math.round(w * 3600_000),
    mode: i % 3 === 0 ? "daily" : "random", day: "2026-07-" + String((i % 28) + 1).padStart(2, "0"),
    name: "Carl", won: floor === 18, floor, timeSec: 84 * floor + Math.round(w * 240),
    level: Math.min(35, 3 + floor * 2), kills: floor * 26 + Math.round(w * 44),
    damageDealt: floor * 980 + Math.round(w * 1500), damageTaken: floor * 245 + Math.round(w * 380),
    gold: 380, viewers: 9_800 + i * 941, favorites: 240 + i * 23, sponsors: i % 4, seed: 2000 + i,
  });
}

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });

await page.addInitScript((hist) => {
  localStorage.setItem("dcc:token:v1", "CRITIC5-TOKEN-AAAA01");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:history:v1", JSON.stringify(hist));
  localStorage.setItem("dcc:consent:v1", "public");
}, HISTORY);

const log = [];
const rec = (k, v) => { log.push(`\n===== ${k} =====\n${typeof v === "string" ? v : JSON.stringify(v, null, 1)}`); console.log("--- " + k + "\n" + (typeof v === "string" ? v : JSON.stringify(v))); };
const shot = async (n, sel) => {
  await (sel ? page.locator(sel) : page).screenshot({ timeout: 240000, path: `${OUT}/${SCENARIO}-${n}.png` });
  console.log("saved", n);
};

async function boot(q = "") {
  await page.goto(BASE + q, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 }).catch(() => console.error("WARN assets"));
  await page.waitForFunction(() => { const l = document.getElementById("loading"); return !l || l.classList.contains("done") || getComputedStyle(l).display === "none"; }, null, { timeout: 180000 }).catch(() => console.error("WARN loading"));
  await page.waitForTimeout(1800);
}

// THE MEASUREMENT. No scrollbars means: nothing scrolls, and nothing is
// clipped. Report both, per visible overlay, at the real viewport.
const FIT = `(() => {
  const out = [];
  const vw = innerWidth, vh = innerHeight;
  const de = document.documentElement;
  out.push({ el: "document", scrollH: de.scrollHeight, clientH: de.clientHeight, scrollW: de.scrollWidth, clientW: de.clientWidth,
             overflowY: de.scrollHeight - de.clientHeight, overflowX: de.scrollWidth - de.clientWidth, ov: "-", scrollable: de.scrollHeight > de.clientHeight + 1 });
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const scrollsY = el.scrollHeight > el.clientHeight + 1;
    const scrollsX = el.scrollWidth > el.clientWidth + 1;
    const canScrollY = /auto|scroll/.test(cs.overflowY), canScrollX = /auto|scroll/.test(cs.overflowX);
    const clipped = /hidden|clip/.test(cs.overflowY) && scrollsY;
    const offscreen = r.bottom > vh + 1 || r.top < -1 || r.right > vw + 1 || r.left < -1;
    if (!scrollsY && !scrollsX && !offscreen) continue;
    out.push({
      el: (el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).slice(0,2).join(".") : "")),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      scrollH: el.scrollHeight, clientH: el.clientHeight,
      overflowY: scrollsY ? el.scrollHeight - el.clientHeight : 0,
      overflowX: scrollsX ? el.scrollWidth - el.clientWidth : 0,
      ov: cs.overflowY + "/" + cs.overflowX,
      SCROLLBAR: (scrollsY && canScrollY) || (scrollsX && canScrollX),
      CLIPPED: clipped, OFFSCREEN: offscreen,
    });
  }
  return out;
})()`;

const fit = async (label) => {
  const r = await page.evaluate(FIT);
  const bad = r.filter((x) => x.SCROLLBAR || x.CLIPPED || x.OFFSCREEN || (x.el === "document" && x.scrollable));
  rec("FIT " + label + " @" + page.viewportSize().width + "x" + page.viewportSize().height,
    bad.length ? bad : "clean (" + r.length + " candidates examined)");
  return bad;
};

async function playAndDie(opts = {}) {
  if (!opts.test) {
    await page.click("#m-daily"); await page.waitForTimeout(700);
    await page.click("#m-cast-go");
  }
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 120000 });
  const read = () => page.evaluate(() => {
    const s = window.__dcc.state, pl = s.players[0];
    const near = s.monsters.filter((m) => m.hp > 0)
      .map((m) => ({ d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y), x: m.pos.x, y: m.pos.y }))
      .sort((a, c) => a.d - c.d)[0];
    return { status: s.status, hp: pl.hp, floor: s.floor, dx: near ? near.x - pl.pos.x : 0, dy: near ? near.y - pl.pos.y : 0, d: near ? near.d : 99 };
  });
  for (let i = 0; i < (opts.rounds ?? 70); i++) {
    const st = await read().catch(() => null);
    if (!st || st.status !== "playing") break;
    const keys = [];
    if (st.d > 1.2) {
      if (st.dy < -0.4) keys.push("w"); if (st.dy > 0.4) keys.push("s");
      if (st.dx < -0.4) keys.push("a"); if (st.dx > 0.4) keys.push("d");
    }
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(520);
    for (const k of keys) await page.keyboard.up(k);
    // fight only for the first N rounds, then stand still and let it kill us
    if (i < (opts.fightFor ?? 14) && st.d < 2.2) {
      await page.mouse.click(W / 2 + st.dx * 40, H / 2 + st.dy * 40).catch(() => { });
    }
  }
  await page.waitForFunction(() => window.__dcc?.state?.status !== "playing", null, { timeout: 60000 }).catch(() => rec("WARN", "never left playing"));
}

async function timeline(tag) {
  const t0 = Date.now();
  for (const m of [0, 600, 1200, 2000, 3200, 5000, 8000, 12000]) {
    const wait = m - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    const el = await page.evaluate(() => {
      const r = document.getElementById("recap");
      const vis = r && getComputedStyle(r).display !== "none";
      const txt = (id) => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== "none" ? e.innerText.replace(/\s+/g, " ").trim().slice(0, 200) : null; };
      return {
        visible: !!vis, opacity: r ? getComputedStyle(r).opacity : null,
        letter: txt("recap-letter"), title: txt("recap-title"), sub: txt("recap-sub"),
        basis: txt("recap-basis"), ladder: txt("recap-ladder"), seal: txt("recap-seal"),
        death: txt("recap-death"), mark: txt("recap-mark"), banked: txt("recap-banked"),
        note: txt("recap-note"),
      };
    });
    rec(`${tag} t+${m}ms`, el);
    await shot(`${tag}-tl-${String(m).padStart(5, "0")}`);
  }
}

if (SCENARIO === "boards") {
  await boot();
  await fit("menu");
  await page.click("#m-standings"); await page.waitForTimeout(3000);
  await shot("standings-contracts"); await fit("standings/contracts");
  for (const t of ["alltime", "bands", "rivals"]) {
    const b = page.locator(`[data-lt="${t}"]`);
    if (await b.count()) {
      await b.click(); await page.waitForTimeout(2400);
      await shot("standings-" + t); await fit("standings/" + t);
    } else rec("missing tab", t);
  }
  // drill into a row — the thing that makes a board more than a list
  const row = page.locator("#ladder-body .brow, #ladder-body li").first();
  if (await row.count()) {
    await row.click().catch(() => { }); await page.waitForTimeout(1600);
    await shot("row-detail"); await fit("row-detail");
    rec("row detail text", await page.evaluate(() => document.getElementById("ladder-body")?.innerText.replace(/\s+/g, " ").slice(0, 1400)));
  }
  await page.keyboard.press("Escape"); await page.waitForTimeout(900);
  const cs = page.locator("#m-careerset");
  if (await cs.count()) { await cs.click(); await page.waitForTimeout(3000); await shot("career"); await fit("career"); }
} else if (SCENARIO === "fit") {
  for (const [w, h] of [[1366, 768], [1600, 900], [1280, 720], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    await boot();
    await page.click("#m-standings"); await page.waitForTimeout(3000);
    await fit("standings/contracts");
    for (const t of ["alltime", "bands", "rivals"]) {
      const b = page.locator(`[data-lt="${t}"]`);
      if (await b.count()) { await b.click(); await page.waitForTimeout(2200); await fit("standings/" + t); }
    }
    await shot(`bands-${w}x${h}`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(700);
    const cs = page.locator("#m-careerset");
    if (await cs.count()) { await cs.click(); await page.waitForTimeout(2600); await fit("career"); await shot(`career-${w}x${h}`); }
  }
} else if (SCENARIO === "win") {
  await boot("&test&floor=18&level=34&gear=level&abilities=all&seed=7");
  rec("win scenario", "driving floor 18 to a clear is not scripted; capturing the deep-death verdict instead if the boss wins");
  await playAndDie({ test: true, rounds: 40, fightFor: 40 });
  await page.waitForTimeout(2500);
  await timeline("win");
  await fit("verdict/deep");
} else {
  await boot();
  await playAndDie({ fightFor: 13, rounds: 70 });
  await timeline("death");
  await fit("verdict");
  // held TAB — the scoreboard drill-down
  await page.keyboard.down("Tab"); await page.waitForTimeout(1400);
  await shot("tab"); await fit("verdict/TAB");
  rec("TAB text", await page.evaluate(() => (document.querySelector("#scoreboard, #recap .sb, #tabboard") || document.body).innerText.replace(/\s+/g, " ").slice(0, 2000)));
  await page.keyboard.up("Tab"); await page.waitForTimeout(500);
  // the drawer
  const e = page.locator("#recap-earned");
  if (await e.count()) { await e.click().catch(() => { }); await page.waitForTimeout(800); await shot("earned"); await fit("verdict/earned"); }
  // share sheet
  const s = page.locator("#recap-share");
  if (await s.count()) { await s.click().catch(() => { }); await page.waitForTimeout(2200); await shot("share"); await fit("share"); }
  await page.keyboard.press("Escape"); await page.waitForTimeout(600);
  // what the server actually holds after this run
  const dump = await page.evaluate(async (api) => {
    const j = async (u) => { try { return (await fetch(api + u)).text(); } catch (e) { return "ERR " + e; } };
    return { contracts: (await j("/boards/contracts")).slice(0, 900), health: await j("/health") };
  }, API);
  rec("server after run", dump);
}

writeFileSync(`${OUT}/${SCENARIO}-log.txt`, log.join("\n"));
await browser.close();
console.log("DONE", SCENARIO);
