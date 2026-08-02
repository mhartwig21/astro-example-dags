// ROUND 4 ACCEPTANCE CRITIC — independent capture. Plays REAL runs against a
// REAL server (clean DB on :5442) and photographs the ten seconds after death
// as a TIMELINE, because that is the thing under judgement.
//
//   node tools/_critic4.mjs                 ranked daily, linked-ish account
//   SCENARIO=anon node tools/_critic4.mjs   the DEFAULT player: no provider
//   SCENARIO=deep node tools/_critic4.mjs   test chamber at depth
//   SCENARIO=boards node tools/_critic4.mjs standings + career, no run
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "tools/_critic4";
const API = process.env.API ?? "http://localhost:5442";
const W = Number(process.env.W ?? 1600), H = Number(process.env.H ?? 900);
const SCENARIO = process.env.SCENARIO ?? "daily";
const BASE = `http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`;
mkdirSync(OUT, { recursive: true });

// A believable local career so the grade has a comparison set.
const HISTORY = [];
for (let i = 0; i < 31; i++) {
  const floor = [2, 3, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 11, 12, 13, 15, 18][i % 20];
  const wob = ((i * 2654435761) % 997) / 997;
  HISTORY.push({
    endedAt: Date.now() - (i + 1) * 3600_000 * 7 - Math.round(wob * 3600_000),
    mode: i % 3 === 0 ? "daily" : "random", day: "2026-07-" + String((i % 28) + 1).padStart(2, "0"),
    name: "Carl", won: floor === 18, floor, timeSec: 90 * floor + Math.round(wob * 220),
    level: Math.min(35, 3 + floor * 2), kills: floor * 28 + Math.round(wob * 41),
    damageDealt: floor * 900 + Math.round(wob * 1300), damageTaken: floor * 260 + Math.round(wob * 410),
    gold: 400, viewers: 11_400 + i * 873, favorites: 287 + i * 19, sponsors: i % 4, seed: 1000 + i,
  });
}

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });

await page.addInitScript(([scenario, hist]) => {
  localStorage.setItem("dcc:token:v1", "CRITIC4-" + scenario.toUpperCase() + "-TOKEN01");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:history:v1", JSON.stringify(hist));
  if (scenario !== "consent") localStorage.setItem("dcc:consent:v1", "public");
}, [SCENARIO, HISTORY]);

const log = [];
const rec = (k, v) => { log.push(`\n===== ${k} =====\n${v}`); console.log("--- " + k + "\n" + v); };
const shot = async (n, sel) => {
  await (sel ? page.locator(sel) : page).screenshot({ timeout: 300000, path: `${OUT}/${SCENARIO}-${n}.png` });
  console.log("saved", n);
};

async function boot(q = "") {
  await page.goto(BASE + q, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 }).catch(() => console.error("WARN assets"));
  await page.waitForFunction(() => { const l = document.getElementById("loading"); return !l || l.classList.contains("done") || getComputedStyle(l).display === "none"; }, null, { timeout: 180000 }).catch(() => console.error("WARN loading"));
  await page.waitForTimeout(2000);
}

async function playAndDie(opts = {}) {
  await page.setViewportSize({ width: 720, height: 420 });
  if (!opts.test) {
    await page.click("#m-daily"); await page.waitForTimeout(700);
    await page.click("#m-cast-go");
  }
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
  const read = () => page.evaluate(() => {
    const s = window.__dcc.state, pl = s.players[0];
    const near = s.monsters.filter((m) => m.hp > 0)
      .map((m) => ({ d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y), x: m.pos.x, y: m.pos.y }))
      .sort((a, c) => a.d - c.d)[0];
    return { status: s.status, hp: pl.hp, floor: s.floor, dx: near ? near.x - pl.pos.x : 0, dy: near ? near.y - pl.pos.y : 0, d: near ? near.d : 99 };
  });
  for (let i = 0; i < (opts.rounds ?? 60); i++) {
    const st = await read().catch(() => null);
    if (!st || st.status !== "playing") break;
    const keys = [];
    if (st.d > 1.1) {
      if (st.dy < -0.4) keys.push("w"); else if (st.dy > 0.4) keys.push("s");
      if (st.dx > 0.4) keys.push("d"); else if (st.dx < -0.4) keys.push("a");
    }
    if (i < (opts.fightFor ?? 14)) keys.push(" ");
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(1200);
    for (const k of keys) await page.keyboard.up(k);
  }
  await page.waitForFunction(() => window.__dcc.state.status !== "playing", null, { timeout: 180000 })
    .catch(() => console.error("  (never died)"));
  await page.setViewportSize({ width: W, height: H });
}

// ---- the ten seconds, as frames ----
async function timeline() {
  const t0 = Date.now();
  const marks = [0, 900, 1800, 3000, 5000, 8000, 12000];
  let prev = 0;
  for (const m of marks) {
    const wait = m - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    const el = await page.evaluate(() => {
      const r = document.getElementById("recap");
      const vis = r && getComputedStyle(r).display !== "none";
      const seal = document.querySelector("#recap .seal, #recap [class*='seal'], #recap [id*='seal']");
      return {
        recapVisible: !!vis,
        recapOpacity: r ? getComputedStyle(r).opacity : null,
        sealText: seal ? seal.textContent.trim().slice(0, 90) : null,
        sealClass: seal ? seal.className : null,
      };
    });
    rec(`t+${m}ms`, JSON.stringify(el));
    await shot(`tl-${String(m).padStart(5, "0")}`);
    prev = m;
  }
}

if (SCENARIO === "boards") {
  await boot();
  await page.click("#m-standings"); await page.waitForTimeout(2600);
  await shot("standings-contracts");
  for (const t of ["alltime", "bands", "rivals"]) {
    const b = page.locator(`[data-lt="${t}"]`);
    if (await b.count()) { await b.click(); await page.waitForTimeout(2200); await shot("standings-" + t); }
    else rec("missing tab", t);
  }
  await page.keyboard.press("Escape"); await page.waitForTimeout(800);
  const cs = page.locator("#m-careerset");
  if (await cs.count()) { await cs.click(); await page.waitForTimeout(2600); await shot("career"); }
} else if (SCENARIO === "deep") {
  await boot("&test&floor=13&level=22&gear=level&abilities=all");
  await playAndDie({ test: true, rounds: 26, fightFor: 16 });
  await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 30000 });
  await page.waitForTimeout(7000);
  await shot("verdict");
} else {
  await boot();
  await playAndDie({ fightFor: 12, rounds: 60 });
  await timeline();
  // held TAB
  await page.keyboard.down("Tab"); await page.waitForTimeout(1100);
  await shot("tab"); await page.keyboard.up("Tab");
  // expand the math
  const m = page.locator("#recap [data-math], #recap .math-toggle, #recap :text('SHOW THE MATH')").first();
  if (await m.count().catch(() => 0)) { await m.click().catch(() => { }); await page.waitForTimeout(900); await shot("math"); }
  // what the server actually holds
  const dump = await page.evaluate(async (api) => {
    const r = await fetch(api + "/boards/contracts").then((x) => x.text()).catch((e) => "ERR " + e);
    const h = await fetch(api + "/health").then((x) => x.text()).catch((e) => "ERR " + e);
    return { boards: r.slice(0, 1200), health: h };
  }, API);
  rec("server after run", JSON.stringify(dump, null, 1));
}

writeFileSync(`${OUT}/${SCENARIO}-log.txt`, log.join("\n"));
await browser.close();
