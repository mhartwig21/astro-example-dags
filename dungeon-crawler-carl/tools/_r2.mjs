// Elevation round 2 acceptance. Drives the REAL client against a REAL server
// and measures the things the blocker list measured, so every fix has a number
// beside it rather than an assertion.
//
//   node tools/_r2.mjs            the ranked daily path at 1600x900
//   SCENARIO=refuse node ...      a run the verifier genuinely rejects
//   W=1366 H=768 node ...         the small-viewport consent case
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "tools/_r2";
const API = "http://localhost:5441";
const W = Number(process.env.W ?? 1600), H = Number(process.env.H ?? 900);
const SCENARIO = process.env.SCENARIO ?? "daily";
const TAG = process.env.TAG ?? `${SCENARIO}-${W}x${H}-`;
const BASE = `http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });
await page.addInitScript(([scenario]) => {
  localStorage.setItem("dcc:token:v1", "R2-" + scenario.toUpperCase() + "-TOKEN-0001");
  localStorage.setItem("dcc:name:v1", "Carl");
  if (scenario !== "daily") localStorage.setItem("dcc:consent:v1", "public");
  // Contrast, measured off the live DOM against the first painted ancestor.
  window.__contrast = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const lum = (c) => {
      const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
        const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const cs = getComputedStyle(el);
    let bgEl = el, bg = "rgb(23,19,16)";
    while (bgEl) {
      const c = getComputedStyle(bgEl).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { bg = c; break; }
      bgEl = bgEl.parentElement;
    }
    const a = lum(cs.color) + 0.05, b = lum(bg) + 0.05;
    return { sel, size: cs.fontSize, ratio: +(Math.max(a, b) / Math.min(a, b)).toFixed(2) };
  };
}, [SCENARIO]);

const log = [];
const rec = (k, v) => { log.push(`\n===== ${k} =====\n${v}`); console.log("---", k, "\n" + v); };
const settle = async () => {
  await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } });
  await page.waitForTimeout(200);
};
const shot = async (n, sel) => {
  await settle();
  await (sel ? page.locator(sel) : page).screenshot({ timeout: 300000, path: `${OUT}/${TAG}${n}.png` });
};

await page.goto(BASE, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await page.waitForTimeout(2500);

// ===== BLOCKER 1: the front door signs for the contract ===================
await page.click("#m-daily");
await page.waitForFunction(() => document.getElementById("menu").classList.contains("casting"), null, { timeout: 30000 });
await page.waitForTimeout(1200);
await page.click("#m-cast-go");
await page.waitForFunction(() => document.getElementById("menu").style.display === "none", null, { timeout: 30000 });
// ...and wait for the RUN, not for the menu backdrop, which is already
// status:"playing" and would answer the question with the wrong dungeon.
await page.waitForFunction(() => window.__dcc?.state?.elapsed > 0.2, null, { timeout: 120000 });
const evt = await (await fetch(`${API}/events/current`)).json();
rec("BLOCKER 1 — the menu's DAILY CRAWL tile", await page.evaluate((serverSeed) => JSON.stringify({
  clientSeed: window.__dcc.state.seed,
  serverDailyContractSeed: serverSeed,
  sameDungeon: window.__dcc.state.seed === serverSeed,
  runEvent: window.__dcc.runEvent ?? null,
  ticketed: !!window.__dcc.runEvent,
}, null, 1), evt.daily.seed));

for (let i = 0; i < 5; i++) {
  await page.keyboard.down("w"); await page.waitForTimeout(700); await page.keyboard.up("w");
  await page.keyboard.down("j"); await page.waitForTimeout(600); await page.keyboard.up("j");
}
if (SCENARIO === "refuse") {
  // A GENUINE REJECTION, not a mocked one: inflate the live kill count so the
  // recorder's claim disagrees with what the server's replay will produce.
  await page.evaluate(() => { window.__dcc.state.players[0].kills += 500; });
}
await page.evaluate(() => {
  const s = window.__dcc.state; s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead";
});
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 });

// ===== BLOCKER 4: the DOCKED consent case, measured ========================
await page.waitForTimeout(1500);
if (await page.evaluate(() => {
  const c = document.getElementById("consent");
  return !!c && getComputedStyle(c).display !== "none";
})) {
  await settle();
  rec("BLOCKER 4 — consent card DOCKED", await page.evaluate(() => {
    const p = document.querySelector("#recap .panel").getBoundingClientRect();
    const c = document.getElementById("consent").getBoundingClientRect();
    const btn = document.querySelector("#consent .cbtns").getBoundingClientRect();
    const medal = document.getElementById("recap-medal").getBoundingClientRect();
    return JSON.stringify({
      viewport: [innerWidth, innerHeight],
      panelTop: Math.round(p.top), panelBottom: Math.round(p.bottom),
      medalTop: Math.round(medal.top),
      consentTop: Math.round(c.top), consentButtonsBottom: Math.round(btn.bottom),
      verdictFullyOnScreen: p.top >= 0 && p.bottom <= innerHeight,
      medalNotClipped: medal.top >= 0,
      submitButtonsOnScreen: btn.bottom <= innerHeight,
      panelOverlapsCard: Math.round(Math.max(0, p.bottom - c.top)),
    }, null, 1);
  }));
  await shot("A-consent");
  await page.evaluate(() => [...document.querySelectorAll("#consent button")]
    .find((b) => /PUBLIC/i.test(b.textContent))?.click());
}

// ===== the ten seconds =====================================================
await page.waitForTimeout(11000);
await settle();
await shot("B-verdict");

rec("THE VERDICT, as it reads", await page.evaluate(() => {
  const t = (id) => (document.getElementById(id)?.innerText ?? "(hidden)").replace(/\n+/g, " | ");
  return [
    "LADDER : " + t("recap-ladder"),
    "SEAL   : " + t("recap-seal"),
    "MARK   : " + t("recap-mark"),
    "BANKED : " + t("recap-banked"),
    "EARNED : " + t("recap-earned"),
  ].join("\n");
}));

// ===== BLOCKER 2: no ladder furniture on a refused run =====================
rec("BLOCKER 2 — what the screen says about a run in this state",
  await page.evaluate(() => {
    const txt = document.querySelector("#recap .panel").innerText;
    const refused = /REFUSED/.test(txt);
    return JSON.stringify({
      sealSaysRefused: refused,
      ladderPlateShown: !!document.querySelector("#recap .ladderline")
        && getComputedStyle(document.querySelector("#recap .ladderline")).display !== "none",
      ladderClass: document.getElementById("recap-ladder").className,
      claimsBoardRow: /still holds its board row/.test(txt),
      claimsNewPb: /NEW PB/.test(txt),
      bankedStripShown: getComputedStyle(document.getElementById("recap-banked")).display !== "none",
    }, null, 1);
  }));

// ===== BLOCKER 7: broadcast or dialog? =====================================
rec("BLOCKER 7 — the default state's footprint", await page.evaluate(() => {
  const el = document.querySelector("#recap .panel");
  const p = el.getBoundingClientRect();
  return JSON.stringify({
    viewport: [innerWidth, innerHeight],
    panel: [Math.round(p.width), Math.round(p.height)],
    at: [Math.round(p.left), Math.round(p.top)],
    screenShare: +((p.width * p.height) / (innerWidth * innerHeight) * 100).toFixed(1) + "%",
    scrollsInsideItself: el.scrollHeight > el.clientHeight + 1,
  }, null, 1);
}));

// ===== BLOCKER 5: WCAG AA across the explanation + navigation layer ========
rec("BLOCKER 5 — contrast (target 4.5:1 at these sizes)",
  await page.evaluate(() => [
    "#recap .vbasis", "#recap .vpart .pd", "#recap .earned .caret", "#recap .rhint",
    "#recap .rminor button", "#recap .mark .msrc", "#recap .ladderline .lnote",
    "#recap .vseal .vk", "#recap .banked .bl", "#recap .death .dhead", "#recap .vline",
  ].map((s) => window.__contrast(s)).filter(Boolean)
    .map((r) => `${r.ratio >= 4.5 ? "PASS" : "fail"}  ${String(r.ratio).padStart(6)}:1  ${r.size.padStart(7)}  ${r.sel}`)
    .join("\n")));

// ===== BLOCKER 12: no credential on the wire ===============================
const board = await (await fetch(`${API}/boards/deepest`)).json();
rec("BLOCKER 12 — GET /boards/deepest", JSON.stringify({
  keys: Object.keys(board),
  entryKeysCarryAccountId: JSON.stringify(board).includes("accountId"),
  firstEntry: board.entries?.[0] ?? board.verified?.[0] ?? null,
  unprovenCount: board.unproven?.length ?? "(absent)",
}, null, 1));

// ===== BLOCKER 10: the standings panel, tab to tab ========================
await page.evaluate(() => document.getElementById("recap-standings")?.click());
await page.waitForTimeout(2500);
const tabs = ["contracts", "alltime", "bands", "rivals"];
const geo = [];
for (const t of tabs) {
  await page.evaluate((tab) => document.querySelector(`[data-lt="${tab}"]`)?.click(), t);
  await page.waitForTimeout(1400);
  await settle();
  geo.push(await page.evaluate((tab) => {
    const f = document.querySelector("#ladder .set-frame").getBoundingClientRect();
    const ke = document.querySelector("#ladder .set-frame > .kicker");
    const rng = document.createRange(); rng.selectNodeContents(ke);
    const k = rng.getBoundingClientRect();
    const c = document.querySelector("#ladder .set-close").getBoundingClientRect();
    return `${tab.padEnd(10)} frame ${Math.round(f.width)}x${Math.round(f.height)}  ` +
      `kicker/close overlap ${Math.round(Math.max(0, k.right - c.left))}px`;
  }, t));
  await shot("C-standings-" + t);
}
rec("BLOCKER 10 — the standings frame across tabs", geo.join("\n"));

// ===== BLOCKER 3: the crawler's two ledgers ===============================
await page.evaluate(() => document.getElementById("ladder-close")?.click());
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById("m-careerset")?.click());
await page.waitForFunction(() => document.getElementById("career").classList.contains("on"), null, { timeout: 30000 });
await page.waitForTimeout(2500);
await settle();
await shot("D-career");
rec("BLOCKER 3 — THE NUMBERS", await page.evaluate(() => {
  const g = [...document.querySelectorAll("#career .lgroup")];
  return g.length
    ? g.map((x) => x.innerText).join("\n----\n")
    : "(no attributed groups — still one mixed list)";
}));

writeFileSync(`${OUT}/${TAG}dump.txt`, log.join("\n"));
await browser.close();
console.log("\nwrote", OUT + "/" + TAG + "*");
