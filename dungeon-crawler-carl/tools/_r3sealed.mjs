// THE SEALED STATE, EARNED. No state poking: a mutated world is precisely what
// the verifier refuses, which is why every unearned capture shows REFUSED. The
// crawler walks in, never swings, and the collapse timer does the job the sim
// was always going to do. Then: the board the seal NAMES is opened and counted.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const API = "http://localhost:5442";
mkdirSync("tools/_r3", { recursive: true });
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
// Play small: under SwiftShader the fill rate dilates sim time, and the
// collapse clock has to run in SIM seconds. Back to 1600x900 to photograph.
const p = await b.newPage({ viewport: { width: 520, height: 340 }, deviceScaleFactor: 1 });
p.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await p.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "R3-DAILY-TOKEN-0001");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:consent:v1", "public");
});
await p.goto(`http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1&q=low`, { waitUntil: "load", timeout: 120000 });
await p.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await p.waitForTimeout(2500);
await p.click("#m-daily");
await p.waitForFunction(() => document.getElementById("menu").classList.contains("casting"), null, { timeout: 30000 });
await p.waitForTimeout(900);
await p.click("#m-cast-go");
await p.waitForFunction(() => window.__dcc?.state?.elapsed > 0.2, null, { timeout: 120000 });
console.log("run:", await p.evaluate(() => JSON.stringify({ seed: window.__dcc.state.seed, runEvent: window.__dcc.runEvent })));
const t0 = Date.now();
while (Date.now() - t0 < 20 * 60_000) {
  await p.waitForTimeout(4000);
  const st = await p.evaluate(() => ({ s: window.__dcc.state.status, hp: Math.round(window.__dcc.state.players[0].hp), e: Math.round(window.__dcc.state.elapsed) }));
  if (st.s !== "playing") { console.log("ended:", JSON.stringify(st)); break; }
}
await p.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 90000 });
await p.setViewportSize({ width: 1600, height: 900 });
await p.waitForTimeout(22000);
await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } });
await p.waitForTimeout(300);
const log = [];
const rec = (k, v) => { log.push(`\n===== ${k} =====\n${v}`); console.log("---", k, "\n" + v); };

rec("THE SEALED VERDICT", await p.evaluate(() => {
  const t = (id) => (document.getElementById(id)?.innerText ?? "(hidden)").replace(/\n+/g, " | ");
  return ["LADDER : " + t("recap-ladder"), "SEAL   : " + t("recap-seal"),
    "MARK   : " + t("recap-mark"), "EARNED : " + t("recap-earned"),
    "sealClass: " + document.getElementById("recap-seal").className,
    "submitResult: " + JSON.stringify(window.__dcc.submitResult)].join("\n");
}));
await p.screenshot({ timeout: 300000, path: "tools/_r3/sealed-1600x900.png" });

// BLOCKER 1: the seal names boards — are they the boards the player finds?
const boards = await p.evaluate(() => window.__dcc.submitResult?.boards ?? null);
const counts = {};
for (const kind of ["deepest", "kills", "fastest", "contracts"]) {
  const all = await (await fetch(`${API}/boards/${kind}`)).json();
  const day = await (await fetch(`${API}/boards/${kind}?event=daily`)).json();
  counts[kind] = { allTime: all.entries.length, todaysContract: day.entries.length };
}
rec("BLOCKER 1 — the seal names these boards, and here is what is in them",
  JSON.stringify({ boardsOnTheRow: boards, boardCounts: counts }, null, 1));

const row = await (await fetch(`${API}/boards/deepest`)).json();
rec("BLOCKER 5/15/20 — what a board row now carries",
  JSON.stringify(row.entries[0] ?? null, null, 1).slice(0, 2200));

// THE STANDINGS, with a real row on them.
await p.evaluate(() => document.getElementById("recap-standings")?.click());
await p.waitForTimeout(3000);
const geo = [];
for (const tab of ["contracts", "alltime", "bands", "rivals"]) {
  await p.evaluate((t) => document.querySelector(`[data-lt="${t}"]`)?.click(), tab);
  await p.waitForTimeout(1800);
  await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } });
  geo.push(await p.evaluate((t) => {
    const f = document.querySelector("#ladder .set-frame").getBoundingClientRect();
    return `${t.padEnd(10)} frame ${Math.round(f.width)}x${Math.round(f.height)}  ` +
      `emptyBelow=${Math.round(Math.max(0, innerHeight - f.bottom))}px ` +
      `(${(Math.max(0, innerHeight - f.bottom) / innerHeight * 100).toFixed(0)}%)  ` +
      `rows=${document.querySelectorAll("#ladder .brow").length}`;
  }, tab));
  await p.screenshot({ timeout: 300000, path: `tools/_r3/sealed-standings-${tab}.png` });
}
rec("BLOCKER 8 — the standings, with a sealed row on them", geo.join("\n"));

await p.evaluate(() => document.querySelector(`[data-lt="alltime"]`)?.click());
await p.waitForTimeout(1600);
rec("BLOCKER 7 — is a row identifiable?", await p.evaluate(() =>
  [...document.querySelectorAll("#ladder .brow")].slice(0, 6)
    .map((r) => r.querySelector(".who")?.innerText.replace(/\n+/g, " | ")).join("\n") || "(no rows)"));
await p.evaluate(() => document.querySelector("#ladder .brow [data-more]")?.click());
await p.waitForTimeout(600);
await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } });
await p.screenshot({ timeout: 300000, path: "tools/_r3/sealed-board-detail.png" });
rec("BLOCKER 5 — the verifier-derived detail, rendered", await p.evaluate(() => {
  const d = document.querySelector("#ladder .brow .rdet");
  return d && !d.hasAttribute("hidden") ? d.innerText : "(no detail panel on any row)";
}));

await p.evaluate(() => document.getElementById("ladder-close")?.click());
await p.waitForTimeout(400);
await p.evaluate(() => document.getElementById("m-careerset")?.click());
await p.waitForFunction(() => document.getElementById("career").classList.contains("on"), null, { timeout: 30000 });
await p.waitForTimeout(2500);
await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } });
await p.screenshot({ timeout: 300000, path: "tools/_r3/sealed-career.png" });
rec("BLOCKER 4 — does the chart agree with the ledger under it?", await p.evaluate(() => {
  const txt = document.getElementById("career-body").innerText;
  return JSON.stringify({
    histogramCaption: /Eighteen floors, one bar each — ([^.]+)\./.exec(txt)?.[1] ?? null,
    ledgers: [...document.querySelectorAll("#career .lgroup")].map((x) => x.innerText.replace(/\n+/g, " | ")),
  }, null, 1);
}));

writeFileSync("tools/_r3/sealed-dump.txt", log.join("\n"));
await b.close();
console.log("\nwrote tools/_r3/sealed-*");
