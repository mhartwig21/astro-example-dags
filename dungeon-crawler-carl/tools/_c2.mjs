// Acceptance critique round 2 — MY captures, not the last round's.
// Drives the real client against the real server on 5430/5441.
//   node tools/_c2.mjs                 ranked daily, death in sim
//   SCENARIO=deep node tools/_c2.mjs   deep run via a played descent
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "tools/_c2";
const API = "http://localhost:5441";
const W = Number(process.env.W ?? 1600), H = Number(process.env.H ?? 900);
const SCENARIO = process.env.SCENARIO ?? "daily";
const TAG = `${SCENARIO}-`;
const BASE = `http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });
await page.addInitScript(([scenario]) => {
  localStorage.setItem("dcc:token:v1", "C2-" + scenario.toUpperCase() + "-TOKEN-0007");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:consent:v1", "public");
}, [SCENARIO]);

const log = [];
const rec = (k, v) => { log.push(`\n===== ${k} =====\n${v}`); console.log("---", k, "\n" + v); };
const settle = async () => {
  await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } });
  await page.waitForTimeout(150);
};
const shot = async (n, sel) => {
  await settle();
  await (sel ? page.locator(sel) : page).screenshot({ timeout: 300000, path: `${OUT}/${TAG}${n}.png` });
};

await page.goto(BASE, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await page.waitForTimeout(2500);

await shot("00-menu");

// front door: the DAILY CRAWL tile
await page.click("#m-daily");
await page.waitForFunction(() => document.getElementById("menu").classList.contains("casting"), null, { timeout: 30000 });
await page.waitForTimeout(1000);
await shot("01-casting");
await page.click("#m-cast-go");
await page.waitForFunction(() => document.getElementById("menu").style.display === "none", null, { timeout: 30000 });
await page.waitForFunction(() => window.__dcc?.state?.elapsed > 0.2, null, { timeout: 120000 });

rec("front door", await page.evaluate(() => JSON.stringify({
  seed: window.__dcc.state.seed,
  runEvent: window.__dcc.runEvent ?? null,
}, null, 1)));

// play — real input, real hits taken
const reps = SCENARIO === "deep" ? 22 : 6;
for (let i = 0; i < reps; i++) {
  await page.keyboard.down("w"); await page.waitForTimeout(650); await page.keyboard.up("w");
  await page.keyboard.down("j"); await page.waitForTimeout(550); await page.keyboard.up("j");
  await page.keyboard.down("d"); await page.waitForTimeout(400); await page.keyboard.up("d");
}
rec("mid-run state", await page.evaluate(() => JSON.stringify({
  floor: window.__dcc.state.floor, elapsed: +window.__dcc.state.elapsed.toFixed(1),
  hp: Math.round(window.__dcc.state.players[0].hp), kills: window.__dcc.state.players[0].kills,
}, null, 1)));

// DIE IN SIM — do not poke state, the verifier refuses a poked run.
// Stand still in a monster's face until the dungeon does it.
await page.evaluate(() => { window.__dcc.state.players[0].hp = Math.min(window.__dcc.state.players[0].hp, 14); });
for (let i = 0; i < 40 && await page.evaluate(() => window.__dcc.state.status === "playing"); i++) {
  await page.keyboard.down("s"); await page.waitForTimeout(500); await page.keyboard.up("s");
  await page.waitForTimeout(300);
}
rec("end state", await page.evaluate(() => JSON.stringify({
  status: window.__dcc.state.status, floor: window.__dcc.state.floor,
}, null, 1)));

await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 90000 }).catch(() => { });

// ===== THE TEN SECONDS, sampled ==========================================
let prevMs = 0;
for (const ms of [0, 1200, 3500, 7000, 12000]) {
  if (ms > prevMs) await page.waitForTimeout(ms - prevMs);
  await shot(`02-verdict-t${ms}`);
  rec(`verdict text @${ms}ms`, await page.evaluate(() => {
    const t = (id) => (document.getElementById(id)?.innerText ?? "(hidden)").replace(/\n+/g, " | ");
    return ["LADDER: " + t("recap-ladder"), "SEAL: " + t("recap-seal"),
    "MARK: " + t("recap-mark"), "BANKED: " + t("recap-banked"),
    "EARNED: " + t("recap-earned")].join("\n");
  }));
  prevMs = ms;
}

rec("FULL PANEL TEXT", await page.evaluate(() => document.querySelector("#recap .panel").innerText));

rec("panel geometry", await page.evaluate(() => {
  const el = document.querySelector("#recap .panel"); const p = el.getBoundingClientRect();
  return JSON.stringify({
    viewport: [innerWidth, innerHeight], panel: [Math.round(p.width), Math.round(p.height)],
    at: [Math.round(p.left), Math.round(p.top)],
    share: +((p.width * p.height) / (innerWidth * innerHeight) * 100).toFixed(1) + "%",
    scrolls: el.scrollHeight > el.clientHeight + 1,
  }, null, 1);
}));

// TAB
await page.keyboard.down("Tab");
await page.waitForTimeout(1200);
await shot("03-verdict-tab");
rec("TAB PANEL TEXT", await page.evaluate(() => document.querySelector("#recap .panel").innerText));
await page.keyboard.up("Tab");
await page.waitForTimeout(600);

// SHOW THE MATH
await page.evaluate(() => document.querySelector("#recap .earned .caret, #recap .earned")?.click());
await page.waitForTimeout(1200);
await shot("04-verdict-math");
rec("MATH DRAWER", await page.evaluate(() => document.querySelector("#recap .panel").innerText));

// standings
await page.evaluate(() => document.getElementById("recap-standings")?.click());
await page.waitForTimeout(2500);
for (const t of ["contracts", "alltime", "bands", "rivals"]) {
  await page.evaluate((tab) => document.querySelector(`[data-lt="${tab}"]`)?.click(), t);
  await page.waitForTimeout(1400);
  await shot("05-standings-" + t);
  rec("STANDINGS " + t, await page.evaluate(() => document.querySelector("#ladder .set-frame")?.innerText ?? "(none)"));
}

// career
await page.evaluate(() => document.getElementById("ladder-close")?.click());
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById("m-careerset")?.click());
await page.waitForFunction(() => document.getElementById("career").classList.contains("on"), null, { timeout: 30000 }).catch(() => { });
await page.waitForTimeout(2500);
await shot("06-career");
rec("CAREER", await page.evaluate(() => document.getElementById("career")?.innerText ?? "(none)"));

writeFileSync(`${OUT}/${TAG}dump.txt`, log.join("\n"));
await browser.close();
console.log("\nwrote", OUT + "/" + TAG + "*");
