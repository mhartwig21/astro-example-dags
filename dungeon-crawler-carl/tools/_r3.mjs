// ELEVATION ROUND 3 ACCEPTANCE. Drives the REAL client against a REAL server
// and measures every blocker this round claims to have closed, so each fix has
// a number beside it rather than an assertion.
//
//   node tools/_r3.mjs                 the ranked daily path at 1600x900
//   SCENARIO=refuse node tools/_r3.mjs a run the verifier genuinely rejects
//   SCENARIO=anon   node tools/_r3.mjs the DEFAULT player: no linked identity
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "tools/_r3";
const API = "http://localhost:5442";
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
  localStorage.setItem("dcc:token:v1", "R3-" + scenario.toUpperCase() + "-TOKEN-0001");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:consent:v1", "public");
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

// ===== the front door, and what it promises about CP ======================
await page.click("#m-daily");
await page.waitForFunction(() => document.getElementById("menu").classList.contains("casting"), null, { timeout: 30000 });
await page.waitForTimeout(1200);
await page.click("#m-cast-go");
await page.waitForFunction(() => document.getElementById("menu").style.display === "none", null, { timeout: 30000 });
await page.waitForFunction(() => window.__dcc?.state?.elapsed > 0.2, null, { timeout: 120000 });
const evt = await (await fetch(`${API}/events/current`)).json();
rec("BLOCKER 2 — what the DOOR promises an account with no identity",
  await page.evaluate((serverSeed) => JSON.stringify({
    sameDungeonAsTheContract: window.__dcc.state.seed === serverSeed,
    runEvent: window.__dcc.runEvent ?? null,
    contractNote: window.__dcc.runContractNote ?? null,
  }, null, 1), evt.daily.seed));

for (let i = 0; i < 5; i++) {
  await page.keyboard.down("w"); await page.waitForTimeout(700); await page.keyboard.up("w");
  await page.keyboard.down("j"); await page.waitForTimeout(600); await page.keyboard.up("j");
}
if (SCENARIO === "refuse") {
  await page.evaluate(() => { window.__dcc.state.players[0].kills += 500; });
}
await page.evaluate(() => {
  const s = window.__dcc.state; s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead";
});
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 });
await page.waitForTimeout(13000);
await settle();
await shot("A-verdict");

rec("THE VERDICT, as it reads", await page.evaluate(() => {
  const t = (id) => (document.getElementById(id)?.innerText ?? "(hidden)").replace(/\n+/g, " | ");
  return [
    "SUB    : " + t("recap-sub"),
    "BASIS  : " + t("recap-basis"),
    "LADDER : " + t("recap-ladder"),
    "SEAL   : " + t("recap-seal"),
    "MARK   : " + t("recap-mark"),
    "BANKED : " + t("recap-banked"),
    "EARNED : " + t("recap-earned"),
  ].join("\n");
}));

// ===== BLOCKER 2: the refusal comes with the control ======================
rec("BLOCKER 2 — is there a control beside the demand?", await page.evaluate(() => {
  const seal = document.getElementById("recap-seal");
  const link = document.getElementById("recap-link");
  return JSON.stringify({
    sealText: seal.innerText.replace(/\n+/g, " | "),
    linkButtonExists: !!link,
    linkButtonLabel: link?.textContent ?? null,
    deadSentenceLINKANIDENTITY: /LINK AN IDENTITY/.test(seal.innerText) && !link,
  }, null, 1);
}));

// ===== BLOCKER 3: the rejection prints numbers, not a field name ==========
rec("BLOCKER 3 — the rejection sentence", await page.evaluate(() => {
  const t = document.querySelector("#recap .panel").innerText;
  return JSON.stringify({
    refused: /REFUSED/.test(t),
    printsARawFieldToken: /replay: (status|won|floor|ticks|kills|level|ultimate)\b/.test(t),
    sealLine: document.querySelector("#recap-seal .vl")?.textContent ?? null,
  }, null, 1);
}));

// ===== BLOCKER 12: the grade's basis =====================================
rec("BLOCKER 12 — the basis, measured", await page.evaluate(() => {
  const el = document.getElementById("recap-basis");
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el.querySelector(".bv"));
  const lines = Math.round(el.querySelector(".bv").getClientRects().length);
  return JSON.stringify({
    width: Math.round(r.width), height: Math.round(r.height),
    setFontSize: cs.fontSize, setColor: cs.color, wrappedLines: lines,
    hasContainer: getComputedStyle(el).borderTopWidth !== "0px",
    capChipShown: !document.getElementById("recap-basis-cap").hasAttribute("hidden"),
  }, null, 1);
}));

// ===== BLOCKER 11: one clock =============================================
rec("BLOCKER 11 — do the surfaces agree about the clock?", await page.evaluate(() => {
  const sub = document.getElementById("recap-sub").textContent;
  return JSON.stringify({
    headline: /run time (\d+:\d+)/.exec(sub)?.[1] ?? null,
    ticks: window.__dcc?.runTicks ?? null,
    earnedPointsAt: /ledger (above|below)/.exec(
      document.getElementById("recap-earned").innerText)?.[1] ?? null,
  }, null, 1);
}));

// ===== BLOCKER 6: WATCH is not spent on dismiss ==========================
rec("BLOCKER 6 — every button in #recap", await page.evaluate(() =>
  [...document.querySelectorAll("#recap button")]
    .map((b) => b.id + " : " + b.innerText.replace(/\n+/g, " / ")).join("\n")));

// ===== BLOCKER 10: the TAB sheet =========================================
await page.keyboard.down("Tab");
await page.waitForTimeout(700);
await settle();
await shot("B-verdict-tab");
rec("BLOCKER 10 — does the TAB sheet duplicate its own left column?",
  await page.evaluate(() => JSON.stringify({
    sections: [...document.querySelectorAll("#recap-tab .rsec")].map((s) => s.textContent),
    finalStatsGridStillPresent: !!document.getElementById("recap-stats"),
    showTiles: [...document.querySelectorAll("#recap-show .rstat small")].map((s) => s.textContent),
  }, null, 1)));
await page.keyboard.up("Tab");
await page.waitForTimeout(400);

// ===== BLOCKER 1 + 5 + 7 + 8 + 9: the standings ==========================
await page.evaluate(() => document.getElementById("recap-standings")?.click());
await page.waitForTimeout(3000);
const tabs = ["contracts", "alltime", "bands", "rivals"];
const geo = [];
for (const t of tabs) {
  await page.evaluate((tab) => document.querySelector(`[data-lt="${tab}"]`)?.click(), t);
  await page.waitForTimeout(1800);
  await settle();
  geo.push(await page.evaluate((tab) => {
    const f = document.querySelector("#ladder .set-frame").getBoundingClientRect();
    const body = document.getElementById("ladder-body").getBoundingClientRect();
    return `${tab.padEnd(10)} frame ${Math.round(f.width)}x${Math.round(f.height)}  ` +
      `bottom y=${Math.round(f.bottom)}  emptyBelow=${Math.round(Math.max(0, innerHeight - f.bottom))}px ` +
      `(${((Math.max(0, innerHeight - f.bottom)) / innerHeight * 100).toFixed(0)}% of viewport)  ` +
      `bodyH=${Math.round(body.height)}`;
  }, t));
  await shot("C-standings-" + t);
}
rec("BLOCKER 8 — the standings frame across tabs", geo.join("\n"));

rec("BLOCKER 1 — does the ALL-TIME board the seal names have rows in it?", await (async () => {
  const deepest = await (await fetch(`${API}/boards/deepest`)).json();
  const kills = await (await fetch(`${API}/boards/kills`)).json();
  return JSON.stringify({
    "GET /boards/deepest entries": deepest.entries.length,
    "GET /boards/kills entries": kills.entries.length,
    firstRowCarriesRunKind: deepest.entries[0]?.runKind ?? null,
    firstRowCarriesFilmState: deepest.entries[0]?.film ?? null,
    firstRowPartySize: deepest.entries[0]?.partySize ?? null,
  }, null, 1);
})());

// ===== BLOCKER 5 + 7: the row itself =====================================
await page.evaluate(() => document.querySelector(`[data-lt="alltime"]`)?.click());
await page.waitForTimeout(1600);
rec("BLOCKER 7 — is a row identifiable?", await page.evaluate(() =>
  [...document.querySelectorAll("#ladder .brow")].slice(0, 6)
    .map((r) => r.querySelector(".who")?.innerText.replace(/\n+/g, " | ")).join("\n")));
await page.evaluate(() => document.querySelector("#ladder .brow [data-more]")?.click());
await page.waitForTimeout(500);
await settle();
await shot("D-board-detail");
rec("BLOCKER 5 — the verifier-derived detail, rendered", await page.evaluate(() => {
  const d = document.querySelector("#ladder .brow .rdet");
  return d && !d.hasAttribute("hidden") ? d.innerText : "(no detail panel on any row)";
}));

// ===== BLOCKER 9: how much of each tab is prose ==========================
rec("BLOCKER 9 — explanation vs data, by area", await page.evaluate(async () => {
  const out = [];
  for (const tab of ["contracts", "alltime", "bands", "rivals"]) {
    document.querySelector(`[data-lt="${tab}"]`)?.click();
    await new Promise((r) => setTimeout(r, 1200));
    const body = document.getElementById("ladder-body");
    const total = body.getBoundingClientRect().height * body.getBoundingClientRect().width;
    let prose = 0, words = 0;
    for (const g of body.querySelectorAll(".gate, .usub, .bandsub, .cnamesub, .crule, .buildnote")) {
      const r = g.getBoundingClientRect();
      prose += r.width * r.height;
      words += (g.textContent ?? "").trim().split(/\s+/).length;
    }
    out.push(`${tab.padEnd(10)} prose ${(prose / Math.max(1, total) * 100).toFixed(0)}% of the body, ${words} words`);
  }
  return out.join("\n");
}));

// ===== BLOCKER 4: the career panel =======================================
await page.evaluate(() => document.getElementById("ladder-close")?.click());
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById("m-careerset")?.click());
await page.waitForFunction(() => document.getElementById("career").classList.contains("on"), null, { timeout: 30000 });
await page.waitForTimeout(2500);
await settle();
await shot("E-career");
rec("BLOCKER 4 — does the chart agree with the ledger under it?", await page.evaluate(() => {
  const txt = document.getElementById("career-body").innerText;
  const histo = /Eighteen floors, one bar each — ([^.]+)\./.exec(txt)?.[1] ?? null;
  const g = [...document.querySelectorAll("#career .lgroup")]
    .map((x) => x.innerText.replace(/\n+/g, " | "));
  return JSON.stringify({ histogramCaption: histo, ledgers: g }, null, 1);
}));

// ===== contrast, unchanged target ========================================
rec("contrast (target 4.5:1)", await page.evaluate(() => {
  document.getElementById("career-close")?.click();
  return null;
}) ?? "");
await page.evaluate(() => { document.getElementById("recap").style.display = "flex"; });
await page.waitForTimeout(500);
rec("BLOCKER 12 — contrast on the explanation layer", await page.evaluate(() => [
  "#recap .vbasis .bv", "#recap .vbasis .bk", "#recap .vpart .pd", "#recap .rhint",
  "#recap .rminor button", "#recap .vseal .vk", "#recap .vseal .vl", "#recap .vseal .vactnote",
].map((s) => window.__contrast(s)).filter(Boolean)
  .map((r) => `${r.ratio >= 4.5 ? "PASS" : "fail"}  ${String(r.ratio).padStart(6)}:1  ${r.size.padStart(7)}  ${r.sel}`)
  .join("\n")));

writeFileSync(`${OUT}/${TAG}dump.txt`, log.join("\n"));
await browser.close();
console.log("\nwrote", OUT + "/" + TAG + "*");
