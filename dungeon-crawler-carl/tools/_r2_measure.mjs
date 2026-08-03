// ROUND 2 ACCEPTANCE PROBE — the three screens this round owns, measured on a
// FRESH LOAD at each viewport (never a resize), so nothing can be blamed on
// the harness. ONE browser for the whole run; one page per viewport, closed
// before the next opens.
//
//   node tools/_r2_measure.mjs            (after: writes tools/_critic/r2.json)
//   node tools/_r2_measure.mjs --tag before
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "tools/_critic";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5281/iso.html";
const API = "http://localhost:5383";
const TAG = (process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : "after");
mkdirSync(OUT, { recursive: true });
const ERA = "2804176";
const DAY = new Date().toISOString().slice(0, 10);

const NAMES = ["Katia", "Donut Holes", "Mordecai", "Princess Formidable", "Elle", "Louis",
  "Sledge", "Vlad", "Miriam", "Zev", "Grimaldis", "Ferdinand", "Signet", "Odette",
  "Bautista", "Hekla", "Nurse Tanya", "Quan Ma", "Sixth Sense", "Bomo", "Yolanda",
  "Ren", "Kizaru", "Ostrich", "Hoarder"];
let uid = 0;
function run(o = {}) {
  const i = uid++;
  const floor = o.floor ?? (18 - (i % 9));
  const ticks = o.ticks ?? (24_000 + i * 977);
  return { id: `run-${i}`, name: o.name ?? NAMES[i % NAMES.length],
    publicId: o.publicId ?? `pub${String(i).padStart(4, "0")}`,
    eventId: o.eventId ?? "daily-" + DAY, state: "verified", reason: null, rulesEra: ERA,
    mode: "descent", runKind: "fresh", film: "retained", playable: true,
    won: o.won ?? floor >= 18, floor, timeSec: Math.round(ticks / 60), ticks,
    kills: 140 + i * 13, level: Math.min(35, 6 + floor),
    ultimate: ["airstrike", "cataclysm", "bullettime"][i % 3], partySize: 1,
    attemptNo: (i % 4) + 1, private: false, damageDealt: 18_400 + i * 733,
    damageTaken: 6_200 + i * 211, goldSpent: 900 + i * 37,
    bandSplits: [3100, 4200, 5400, 6100, 7300, 8900].slice(0, Math.ceil(floor / 3)),
    death: o.won ? null : { kind: "monster", name: "Ironworks Foreman" },
    build: { ultimate: "airstrike", actives: ["dash", "bolt", "nova", "flask"], items: [] },
    verifiedAt: Date.now() - i * 3600_000, at: Date.now() - i * 3600_000, bandTicks: o.bandTicks };
}
const PROFILE = () => { uid = 100; return {
  publicId: "pub0000", name: "Carl", seals: 11, runsSubmitted: 19, refused: 2,
  career: { runs: 31, wins: 2, deepest: 18, kills: 2089, time_sec: 22_640 },
  standing: { cp: 3120, rank: 7, entrants: 34, eventsCounted: 6, tier: null, placementRemaining: 0, tierFloor: 60 },
  season: "S5", deathsByFloor: [0,1,2,3,2,4,3,2,1,2,1,1,0,1,0,0,0,1],
  sealedDeathsByFloor: [0,0,1,2,1,2,2,1,1,1,0,0,0,0,0,0,0,0],
  bandBests: [3178, 4291, 5502, null, 7311, null], deepest: 18,
  fastestClear: run({ won: true, floor: 18, ticks: 41_233 }),
  mastery: [{ ultimate: "airstrike", xp: 640 }, { ultimate: "cataclysm", xp: 180 },
    { ultimate: "bullettime", xp: 60 }],
  following: ["pub0001"], recent: Array.from({ length: 5 }, () => run()) }; };
const RIVAL = () => { uid = 200; return {
  eventId: "daily-" + DAY, seed: 2698932116, resolvesAt: Date.now() + 7 * 3600_000,
  rival: { publicId: "pub0001", cp: 3260, name: "Katia" },
  rivalRun: run({ floor: 14, ticks: 33_112 }), myCp: 3120,
  head: { played: 9, mine: 4, theirs: 4, drawn: 1, recent: [
    { eventId: "daily-2026-08-01", won: true, mineFloor: 15, theirFloor: 13, mineTicks: 31_000, theirTicks: 29_400, result: "won" },
    { eventId: "daily-2026-07-31", won: false, mineFloor: 11, theirFloor: 14, mineTicks: 24_100, theirTicks: 30_900, result: "lost" },
    { eventId: "weekly-2026-07-27", won: false, mineFloor: 12, theirFloor: 12, mineTicks: 27_400, theirTicks: 27_400, result: "drew" } ] },
  stake: "no CP changes hands", pairing: "nearest season CP" }; };
const EVENTS = () => ({ season: "S5",
  daily: { id: "daily-" + DAY, kind: "daily", day: DAY, seed: 2698932116,
    opensAt: Date.now() - 6 * 3600_000, closesAt: Date.now() + 18 * 3600_000,
    season: "S5", frozen: false, rulesHash: ERA, entrants: 34 },
  weekly: { id: "weekly-2026-07-27", kind: "weekly", day: "2026-07-27", seed: 771122,
    opensAt: Date.now() - 4 * 86400_000, closesAt: Date.now() + 3 * 86400_000,
    season: "S5", frozen: false, rulesHash: ERA, entrants: 19 } });
const HISTORY = [];
for (let i = 0; i < 31; i++) {
  const floor = [2,3,3,4,5,5,6,6,7,7,8,8,9,9,10,11,12,13,15,18][i % 20];
  const wob = ((i * 2654435761) % 997) / 997;
  HISTORY.push({ endedAt: Date.now() - (i + 1) * 3600_000 * 7 - Math.round(wob * 3600_000),
    mode: i % 3 === 0 ? "daily" : "random", day: "2026-07-" + String((i % 28) + 1).padStart(2, "0"),
    name: "Carl", won: floor === 18, floor, timeSec: 90 * floor + Math.round(wob * 220),
    level: Math.min(35, 3 + floor * 2), kills: floor * 28 + Math.round(wob * 41),
    damageDealt: floor * 900, damageTaken: floor * 260, gold: 400,
    viewers: 11_400 + i * 873, favorites: 287 + i * 19, sponsors: i % 4, seed: 1000 + i });
}

// ---- the two probes, both run IN PAGE -------------------------------------
const SET = ([panelId]) => {
  const panel = document.getElementById(panelId);
  const frame = panel.querySelector(".set-frame");
  const fr = frame.getBoundingClientRect();
  const inner = [];
  for (const el of panel.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const dv = el.scrollHeight - el.clientHeight, dh = el.scrollWidth - el.clientWidth;
    if (dv > 1 && (cs.overflowY === "auto" || cs.overflowY === "scroll")) inner.push({ sel: el.id || el.className, v: dv });
    if (dh > 1 && (cs.overflowX === "auto" || cs.overflowX === "scroll")) inner.push({ sel: el.id || el.className, h: dh });
  }
  let clipped = 0, worst = 0, worstTxt = "";
  const pr = panel.getBoundingClientRect();
  const walk = (el) => { for (const c of el.children) {
    const inks = [...c.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    const r = c.getBoundingClientRect();
    if (inks && r.height > 0 && r.width > 0 && r.bottom > pr.bottom + 1) {
      clipped++; if (r.bottom - pr.bottom > worst) { worst = r.bottom - pr.bottom; worstTxt = c.textContent.trim().slice(0, 40); }
    } walk(c); } };
  walk(panel);
  // ...and ink drawn OUTSIDE the gilt frame, which a bounded frame makes possible.
  let outside = 0;
  const wf = (el) => { for (const c of el.children) {
    const inks = [...c.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    const r = c.getBoundingClientRect();
    if (inks && r.height > 0 && r.width > 0 && r.bottom > fr.bottom + 1) outside = Math.max(outside, r.bottom - fr.bottom);
    wf(c); } };
  wf(frame);
  return {
    overflow: panel.scrollHeight - panel.clientHeight,
    frameOverflow: frame.scrollHeight - frame.clientHeight,
    docOverflow: document.documentElement.scrollHeight - window.innerHeight,
    inner, clipped, clippedPx: Math.round(worst), clippedTxt: worstTxt,
    outsideFramePx: Math.round(outside),
    frameW: Math.round(fr.width), frameH: Math.round(fr.height),
    frameShare: +((fr.width * fr.height) / (innerWidth * innerHeight)).toFixed(3),
    hugs: frame.classList.contains("hugs"),
    boardRows: panel.querySelectorAll("#" + panelId + "-body > .board > li, .board > li").length,
    trimmed: [...panel.querySelectorAll(".fitmore")].map((n) => n.textContent.trim()),
  };
};

const VERDICT = () => {
  const el = document.getElementById("recap");
  const panel = el.querySelector(".panel");
  const pr = panel.getBoundingClientRect();
  const R = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width),
      h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; };
  const basis = el.querySelector(".vbasis"), part0 = el.querySelector(".vpart");
  const hint = el.querySelector(".rhint");
  let clipped = 0, worst = 0, worstTxt = "";
  const walk = (n) => { for (const c of n.children) {
    const inks = [...c.childNodes].some((t) => t.nodeType === 3 && t.textContent.trim().length > 0);
    const r = c.getBoundingClientRect();
    if (inks && r.height > 0 && r.width > 0 && r.bottom > pr.bottom + 1) {
      clipped++; if (r.bottom - pr.bottom > worst) { worst = r.bottom - pr.bottom; worstTxt = c.textContent.trim().slice(0, 44); }
    } walk(c); } };
  walk(panel);
  const cs = getComputedStyle(panel);
  return {
    overflow: panel.scrollHeight - panel.clientHeight,
    hoverflow: panel.scrollWidth - panel.clientWidth,
    clipped, clippedPx: Math.round(worst), clippedTxt: worstTxt,
    vd: cs.getPropertyValue("--vd").trim(), vd0: cs.getPropertyValue("--vd0").trim(),
    vtrack: cs.getPropertyValue("--vtrack").trim(),
    verdictGrid: getComputedStyle(el.querySelector(".verdict")).gridTemplateColumns,
    basis: R(basis), part0: R(part0),
    // Positive = the plate is drawn INTO the first grade tile.
    collisionPx: basis && part0
      ? Math.round(basis.getBoundingClientRect().right - part0.getBoundingClientRect().left) : null,
    basisLeftOfPanelPad: basis
      ? Math.round(basis.getBoundingClientRect().left - (pr.left + parseFloat(cs.paddingLeft))) : null,
    hintBelowPanel: hint ? Math.round(hint.getBoundingClientRect().bottom - pr.bottom) : null,
    panelW: Math.round(pr.width), panelH: Math.round(pr.height),
    screenShare: +((pr.width * pr.height) / (innerWidth * innerHeight)).toFixed(3),
    scrollbarHidden: cs.scrollbarWidth === "none",
    title: document.getElementById("recap-title").textContent,
  };
};

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const out = {};
try {
  for (const [width, height] of [[1366, 768], [1600, 900], [2560, 1440]]) {
    const key = `${width}x${height}`;
    out[key] = {};
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
    const j = (p) => async (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(p) });
    await page.route(`${API}/**`, (r) => { console.log("UNROUTED:", r.request().url()); return j({})(r); });
    await page.route("**/boards/**", async (r) => {
      const u = new URL(r.request().url());
      uid = 0;
      const n = u.searchParams.get("event") ? 12 : (u.searchParams.get("limit") === "1" ? 1 : 25);
      await j({ kind: u.pathname.split("/").pop(), eventId: u.searchParams.get("event") ? "daily-" + DAY : null,
        rulesEra: ERA, splitGate: 20, entries: Array.from({ length: n }, () => run()),
        verified: [], unproven: [] })(r);
    });
    await page.route("**/bands/*", async (r) => {
      const b = Number(new URL(r.request().url()).pathname.split("/").pop());
      uid = 300 + b * 10;
      await j({ kind: "band", rulesEra: ERA, splitGate: 20,
        entries: b <= 1 ? Array.from({ length: 3 }, (_, k) => run({ bandTicks: 3100 + b * 900 + k * 140 })) : [] })(r);
    });
    await page.route("**/crawler/me*", (r) => j(PROFILE())(r));
    await page.route("**/rivals/contract*", (r) => j(RIVAL())(r));
    await page.route("**/events/current*", (r) => j(EVENTS())(r));
    await page.route("**/auth/anon*", (r) => j({ token: "anon.crit" })(r));
    await page.route("**/auth/providers*", (r) => j({ linked: [{ provider: "discord", name: "Carl" }], available: ["discord"] })(r));
    await page.route("**/leaderboard*", (r) => j({ entries: [], unsealed: true })(r));
    await page.route("**/events/*/start*", (r) => j({ eventId: "daily-" + DAY, seed: 2698932116, attemptNo: 1, ticket: "t.1.x", scoresCp: true, rulesHash: ERA, linked: true, unlinkedReason: null })(r));
    await page.route("**/runs*", (r) => j({ runId: "r1", state: "verifying", queued: true, attemptNo: 1, scoresCp: true })(r));
    await page.addInitScript(([hist]) => {
      localStorage.setItem("dcc:token:v1", "CRITIC1");
      localStorage.setItem("dcc:consent:v1", "public");
      localStorage.setItem("dcc:name:v1", "Carl");
      localStorage.setItem("dcc:history:v1", JSON.stringify(hist));
      localStorage.removeItem("dcc:bandbests:v1");
    }, [HISTORY]);

    await page.goto(`${BASE}?debug=1&eagerassets&clean=1&api=${encodeURIComponent(API)}`,
      { waitUntil: "load", timeout: 180000 });
    await page.waitForFunction(() => {
      const l = document.getElementById("loading");
      if (!l) return true;
      const cs = getComputedStyle(l);
      return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0
        || l.getBoundingClientRect().width === 0;
    }, null, { timeout: 300000 });
    await page.waitForTimeout(3000);
    const box = await page.evaluate(() => {
      const l = document.getElementById("loading"); if (!l) return 0;
      const r = l.getBoundingClientRect(); return r.width * r.height; });
    if (box > 0) throw new Error("#loading still has a box");

    // ---- THE STANDINGS, four tabs -----------------------------------------
    await page.click("#m-standings");
    await page.waitForTimeout(2500);
    for (const tab of ["contracts", "alltime", "bands", "rivals"]) {
      await page.click(`[data-lt="${tab}"]`);
      await page.waitForTimeout(1800);
      out[key][tab] = await page.evaluate(SET, ["ladder"]);
      await page.screenshot({ path: `${OUT}/r2-${TAG}-${key}-${tab}.png`, timeout: 180000 });
    }
    const hs = ["contracts", "alltime", "bands", "rivals"].map((t) => out[key][t].frameH);
    out[key].frameRange = Math.max(...hs) - Math.min(...hs);

    // ---- THE CRAWLER -------------------------------------------------------
    await page.click("#ladder-close");
    await page.waitForTimeout(600);
    await page.click("#m-careerset");
    await page.waitForTimeout(3200);
    out[key].career = await page.evaluate(SET, ["career"]);
    await page.screenshot({ path: `${OUT}/r2-${TAG}-${key}-career.png`, timeout: 180000 });
    await page.click("#career-close");
    await page.waitForTimeout(600);

    // ---- THE VERDICT, death then clear -------------------------------------
    await page.click("#m-daily");
    await page.waitForTimeout(1200);
    await page.click("#m-cast-go");
    await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 180000 });
    for (let i = 0; i < 8; i++) { await page.keyboard.down(" "); await page.waitForTimeout(700); await page.keyboard.up(" "); }
    await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      for (let i = 0; i < 3000 && st.status === "playing"; i++) {
        p.hp = 0; d.step({ 0: { move: { x: 0, y: 0 }, useStairs: false } }, 1 / 30);
      }
      if (st.status === "playing") st.status = "dead";
    });
    const upCheck = () => page.evaluate(() => {
      const e = document.getElementById("recap");
      const cs = e && getComputedStyle(e);
      return !!(cs && cs.display !== "none" && e.getBoundingClientRect().width > 0);
    }).catch(() => false);
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { up = await upCheck(); if (!up) await page.waitForTimeout(700); }
    if (!up) throw new Error("#recap never opened on death");
    await page.waitForTimeout(11000);
    // The check-in panel (z 28) can land back over the verdict (z 27) between
    // the edge and the measurement; re-fire the status edge so the card is the
    // thing being photographed rather than the menu on top of it.
    for (let i = 0; i < 4; i++) {
      const h = await page.evaluate(() => document.getElementById("recap").querySelector(".panel").getBoundingClientRect().height);
      if (h > 0) break;
      await page.evaluate(() => { const d = window.__dcc; d.state.status = "playing"; d.state.status = "dead"; });
      await page.waitForTimeout(4000);
    }
    out[key].verdictDeath = await page.evaluate(VERDICT);
    await page.screenshot({ path: `${OUT}/r2-${TAG}-${key}-death.png`, timeout: 300000 });

    await page.evaluate(() => { window.__dcc.state.status = "won"; });
    up = false;
    for (let i = 0; i < 40 && !up; i++) { up = await upCheck(); if (!up) await page.waitForTimeout(700); }
    await page.waitForTimeout(11000);
    out[key].verdictClear = await page.evaluate(VERDICT);
    await page.screenshot({ path: `${OUT}/r2-${TAG}-${key}-clear.png`, timeout: 300000 });

    await page.close();
    // Written per viewport: a crash on the third must not cost the first two.
    writeFileSync(`${OUT}/r2-${TAG}.partial.json`, JSON.stringify(out, null, 2));
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/r2-${TAG}.json`, JSON.stringify(out, null, 2));
for (const [v, m] of Object.entries(out)) {
  console.log(`\n=== ${v} ===`);
  for (const t of ["contracts", "alltime", "bands", "rivals", "career"]) {
    const s = m[t];
    console.log(` ${t.padEnd(10)} over=${String(s.overflow).padStart(4)} frameOver=${String(s.frameOverflow).padStart(4)}` +
      ` outside=${String(s.outsideFramePx).padStart(4)} clipped=${s.clipped}(${s.clippedPx}) frame=${s.frameW}x${s.frameH}` +
      ` share=${s.frameShare} hugs=${s.hugs}`);
    if (s.trimmed.length) console.log(`            trimmed: ${JSON.stringify(s.trimmed)}`);
  }
  console.log(` frame range across tabs: ${m.frameRange}px`);
  for (const k of ["verdictDeath", "verdictClear"]) {
    const d = m[k];
    console.log(` ${k.padEnd(12)} over=${String(d.overflow).padStart(4)} clipped=${d.clipped}(${d.clippedPx}px "${d.clippedTxt}")` +
      ` collision=${d.collisionPx} outPad=${d.basisLeftOfPanelPad} hintBelow=${d.hintBelowPanel}` +
      ` vd=${d.vd}/${d.vd0} track=${d.vtrack} grid=${d.verdictGrid} panel=${d.panelW}x${d.panelH} share=${d.screenShare}` +
      ` sbHidden=${d.scrollbarHidden}`);
  }
}
