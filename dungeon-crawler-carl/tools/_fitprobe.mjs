// Session-only: measure standings/career fit at three viewports. Deleted after use.
//   node tools/_fitprobe.mjs [--shots] [--dense]
// The competitive API is FIXTURED (page.route) so the panels hold realistic
// content: a sparse day (4 signed rows) by default, --dense for a full board.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.env.FIT_OUT ?? "tools/_fit";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5281/iso.html";
const API = "http://localhost:5383";
const SHOTS = process.argv.includes("--shots");
const DENSE = process.argv.includes("--dense");
mkdirSync(OUT, { recursive: true });

const ERA = "2804176";
const NAMES = ["Katia", "Donut Holes", "Mordecai", "Princess Formidable", "Elle", "Louis",
  "Sledge", "Vlad", "Miriam", "Zev", "Grimaldis", "Ferdinand", "Signet", "Odette",
  "Bautista", "Hekla", "Nurse Tanya", "Quan Ma", "Sixth Sense", "Bomo", "Yolanda",
  "Ren", "Kizaru", "Ostrich", "Hoarder"];

let uid = 0;
function run(o = {}) {
  const i = uid++;
  const floor = o.floor ?? (18 - (i % 9));
  const ticks = o.ticks ?? (24_000 + i * 977);
  return {
    id: `run-${i}`, name: o.name ?? NAMES[i % NAMES.length],
    publicId: o.publicId ?? `pub${String(i).padStart(4, "0")}`,
    eventId: o.eventId ?? "daily-2026-08-02",
    state: o.state ?? "verified", reason: null, rulesEra: o.rulesEra ?? ERA,
    mode: "descent", runKind: "fresh", film: "retained", playable: true,
    won: o.won ?? floor >= 18, floor, timeSec: Math.round(ticks / 60), ticks,
    kills: o.kills ?? (140 + i * 13), level: o.level ?? Math.min(35, 6 + floor),
    ultimate: ["airstrike", "cataclysm", "bullettime"][i % 3],
    partySize: 1, attemptNo: (i % 4) + 1, private: false,
    damageDealt: 18_400 + i * 733, damageTaken: 6_200 + i * 211, goldSpent: 900 + i * 37,
    bandSplits: [3100, 4200, 5400, 6100, 7300, 8900].slice(0, Math.ceil(floor / 3)),
    death: o.won ? null : { kind: "monster", name: "Ironworks Foreman" },
    build: { ultimate: "airstrike", actives: ["dash", "bolt", "nova", "flask"], items: [] },
    verifiedAt: Date.now() - i * 3600_000, at: Date.now() - i * 3600_000,
    bandTicks: o.bandTicks,
  };
}

const DAILY_ROWS = DENSE ? 12 : 4;
const ALLTIME_ROWS = DENSE ? 25 : 6;

function boardPage(kind, n) {
  uid = 0;
  return {
    kind, eventId: kind === "daily" ? "daily-2026-08-02" : null, rulesEra: ERA, splitGate: 20,
    entries: Array.from({ length: n }, () => run()),
    verified: [], unproven: [],
  };
}

const PROFILE = () => {
  uid = 100;
  return {
    publicId: "pub0000", name: "Carl", seals: 11, runsSubmitted: 19, refused: 2,
    career: { runs: 31, wins: 2, deepest: 18, kills: 2089, time_sec: 22_640 },
    standing: { cp: 3120, rank: 7, entrants: 34, eventsCounted: 6, tier: null, placementRemaining: 0, tierFloor: 60 },
    season: "S5",
    deathsByFloor: [0,1,2,3,2,4,3,2,1,2,1,1,0,1,0,0,0,1],
    sealedDeathsByFloor: [0,0,1,2,1,2,2,1,1,1,0,0,0,0,0,0,0,0],
    bandBests: [3178, 4291, 5502, null, 7311, null],
    deepest: 18,
    fastestClear: run({ won: true, floor: 18, ticks: 41_233 }),
    mastery: [{ ultimate: "airstrike", xp: 640 }, { ultimate: "cataclysm", xp: 180 },
      { ultimate: "bullettime", xp: 60 }],
    following: ["pub0001"],
    recent: Array.from({ length: 5 }, () => run()),
  };
};

const RIVAL = () => {
  uid = 200;
  return {
    eventId: "daily-2026-08-02", seed: 2698932116, resolvesAt: Date.now() + 7 * 3600_000,
    rival: { publicId: "pub0001", cp: 3260, name: "Katia" },
    rivalRun: run({ floor: 14, ticks: 33_112 }),
    myCp: 3120,
    head: {
      played: 9, mine: 4, theirs: 4, drawn: 1,
      recent: [
        { eventId: "daily-2026-08-01", won: true, mineFloor: 15, theirFloor: 13, mineTicks: 31_000, theirTicks: 29_400, result: "won" },
        { eventId: "daily-2026-07-31", won: false, mineFloor: 11, theirFloor: 14, mineTicks: 24_100, theirTicks: 30_900, result: "lost" },
        { eventId: "weekly-2026-07-27", won: false, mineFloor: 12, theirFloor: 12, mineTicks: 27_400, theirTicks: 27_400, result: "drew" },
      ],
    },
    stake: "no CP changes hands", pairing: "nearest season CP",
  };
};

const HISTORY = [];
for (let i = 0; i < 31; i++) {
  const floor = [2,3,3,4,5,5,6,6,7,7,8,8,9,9,10,11,12,13,15,18][i % 20];
  const wob = ((i * 2654435761) % 997) / 997;
  HISTORY.push({
    endedAt: Date.now() - (i + 1) * 3600_000 * 7 - Math.round(wob * 3600_000),
    mode: i % 3 === 0 ? "daily" : "random",
    day: "2026-07-" + String((i % 28) + 1).padStart(2, "0"),
    name: "Carl", won: floor === 18, floor,
    timeSec: 90 * floor + Math.round(wob * 220),
    level: Math.min(35, 3 + floor * 2),
    kills: floor * 28 + Math.round(wob * 41),
    damageDealt: floor * 900 + Math.round(wob * 1300),
    damageTaken: floor * 260 + Math.round(wob * 410),
    gold: 400, viewers: 11_400 + i * 873 + Math.round(wob * 611),
    favorites: 287 + i * 19 + Math.round(wob * 23), sponsors: i % 4, seed: 1000 + i,
  });
}

const MEASURE = ([panelId, bodyId]) => {
  const panel = document.getElementById(panelId);
  const frame = panel.querySelector(".set-frame");
  const body = document.getElementById(bodyId);
  const more = panel.querySelector(".morebelow");
  // ONLY THINGS THAT ACTUALLY PAINT INK. An empty container stretched to fill
  // is not "filled" — it is the same hole with a border around it, and a
  // metric that counts it lies in exactly the direction that flatters the fix.
  let deepest = 0;
  const walk = (el) => {
    for (const c of el.children) {
      const inks = Array.from(c.childNodes)
        .some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      const r = c.getBoundingClientRect();
      if (inks && r.height > 0 && r.width > 0) deepest = Math.max(deepest, r.bottom + panel.scrollTop);
      walk(c);
    }
  };
  walk(body);
  const fr = frame.getBoundingClientRect();
  const cs = getComputedStyle(frame);
  const frameInnerBottom = fr.bottom + panel.scrollTop - parseFloat(cs.paddingBottom);
  return {
    overflow: panel.scrollHeight - panel.clientHeight,
    hoverflow: panel.scrollWidth - panel.clientWidth,
    frameH: Math.round(fr.height),
    contentBottom: Math.round(deepest),
    dead: Math.round(frameInnerBottom - deepest),
    moreOn: more ? more.classList.contains("on") : false,
  };
};

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

const results = {};
const VIEWS = [[1366, 768], [1600, 900], [2560, 1440]];

for (const [width, height] of VIEWS) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

  const jsonRoute = (payload) => async (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(payload),
  });
  if (!process.env.FIT_LIVE) {
  await page.route("**/boards/**", async (route) => {
    const u = new URL(route.request().url());
    const kind = u.pathname.split("/").pop();
    await jsonRoute(boardPage(kind, u.searchParams.get("event") ? DAILY_ROWS : ALLTIME_ROWS))(route);
  });
  await page.route("**/bands/*", async (route) => {
    const b = Number(new URL(route.request().url()).pathname.split("/").pop());
    uid = 300 + b * 10;
    const rows = b <= 1 ? Array.from({ length: 3 }, (_, k) => run({ bandTicks: 3100 + b * 900 + k * 140 })) : [];
    await jsonRoute({ kind: "band", entries: rows, rulesEra: ERA, splitGate: 20 })(route);
  });
  await page.route("**/rivals/contract*", (route) => jsonRoute(RIVAL())(route));
  await page.route("**/crawler/me*", (route) => jsonRoute(PROFILE())(route));
  }

  await page.addInitScript(([hist]) => {
    localStorage.setItem("dcc:token:v1", "SHOTCRAWLER");
    localStorage.setItem("dcc:consent:v1", "public");
    localStorage.setItem("dcc:name:v1", "Carl");
    localStorage.setItem("dcc:history:v1", JSON.stringify(hist));
    localStorage.removeItem("dcc:bandbests:v1");
  }, [HISTORY]);
  await page.goto(`${BASE}?debug=1&clean=1&noassets&api=${encodeURIComponent(API)}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    return !l || l.classList.contains("done") || getComputedStyle(l).display === "none" || !l.getBoundingClientRect().height;
  }, null, { timeout: 180000 }).catch(() => console.error("WARN loading never cleared"));
  await page.waitForTimeout(3000);

  const key = `${width}x${height}`;
  results[key] = {};

  await page.click("#m-standings");
  await page.waitForTimeout(2500);
  for (const tab of ["contracts", "alltime", "bands", "rivals"]) {
    await page.click(`[data-lt="${tab}"]`);
    await page.waitForTimeout(1600);
    results[key][tab] = await page.evaluate(MEASURE, ["ladder", "ladder-body"]);
    if (SHOTS) await page.screenshot({ path: `${OUT}/${key}-${tab}.png`, timeout: 120000 });
    if (tab === "alltime") {
      const before = await page.evaluate(() =>
        document.querySelectorAll("#ladder-body > .board > .brow").length);
      const btn = page.locator("#ladder-body .fitmore button").first();
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(500);
        const after = await page.evaluate(() =>
          document.querySelectorAll("#ladder-body > .board > .brow").length);
        results[key].unfold = { before, after,
          ...(await page.evaluate(MEASURE, ["ladder", "ladder-body"])) };
        if (SHOTS) await page.screenshot({ path: `${OUT}/${key}-alltime-open.png`, timeout: 120000 });
        await btn.click();
        await page.waitForTimeout(400);
      }
    }
  }
  await page.click("#ladder-close");
  await page.waitForTimeout(500);
  await page.click("#m-careerset");
  await page.waitForTimeout(3000);
  results[key].career = await page.evaluate(MEASURE, ["career", "career-body"]);
  if (SHOTS) await page.screenshot({ path: `${OUT}/${key}-career.png`, timeout: 120000 });
  await page.close();
}

await browser.close();
console.log(`fixture: ${DENSE ? "DENSE" : "SPARSE"} (daily ${DAILY_ROWS} rows, alltime ${ALLTIME_ROWS} rows)`);
for (const [v, tabs] of Object.entries(results)) {
  for (const [t, m] of Object.entries(tabs)) {
    console.log(`${v.padEnd(10)} ${t.padEnd(10)} overflow=${String(m.overflow).padStart(5)}  hoverflow=${String(m.hoverflow).padStart(3)}  dead=${String(m.dead).padStart(5)}  frameH=${String(m.frameH).padStart(5)}  more=${m.moreOn}`);
  }
}
