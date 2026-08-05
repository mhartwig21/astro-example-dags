// FINAL VERIFICATION — surface (c): THE VERDICT / IN MEMORIAM.
// A REAL death: hp is dropped to 1 and the crawler is walked into the nearest
// live pack, so the sim's own combat path kills them and names the killer.
// Nothing sets state.status directly.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const OUT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/polish/dungeon-crawler-carl/shots/_fv";
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:5311/iso.html";

const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--force_high_performance_gpu"] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(`${BASE}?test&floor=6&level=11&abilities=all&gold=300&seed=7&debug=1&eagerassets`,
  { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 });
await page.waitForFunction(() => !!window.__dcc?.state, { timeout: 120000 });
await page.waitForTimeout(3000);

const out = {};
// Walk into the pack, at 1 hp, with the sim doing the killing.
out.staging = await page.evaluate(() => {
  const s = window.__dcc.state;
  const p = s.players[0];
  const mobs = s.monsters.filter((m) => m.alive ?? m.hp > 0);
  if (!mobs.length) return { ok: false, why: "no live monsters on this floor" };
  let best = mobs[0], bd = Infinity;
  for (const m of mobs) {
    const d = (m.pos.x - p.pos.x) ** 2 + (m.pos.y - p.pos.y) ** 2;
    if (d < bd) { bd = d; best = m; }
  }
  p.pos.x = best.pos.x + 0.4; p.pos.y = best.pos.y + 0.4;
  p.hp = 1;
  return { ok: true, mobs: mobs.length, killerCandidate: best.kind ?? best.type ?? null, hp: p.hp };
});
console.log("staging:", JSON.stringify(out.staging));

await page.waitForFunction(() => {
  const el = document.getElementById("recap");
  return !!el && getComputedStyle(el).display !== "none";
}, { timeout: 120000 });
await page.waitForTimeout(4000);

out.simStatus = await page.evaluate(() => ({
  status: window.__dcc.state.status,
  alive: window.__dcc.state.players[0].alive,
  hp: window.__dcc.state.players[0].hp,
  floor: window.__dcc.state.floor,
}));

// THE CENSUS: every distinct thing on the default face competing for attention.
out.face = await page.evaluate(() => {
  const recap = document.getElementById("recap");
  const panel = recap.querySelector(".panel");
  const pr = panel.getBoundingClientRect();
  const visible = (e) => {
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity < 0.05) return false;
    const r = e.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  // Top-level blocks of the panel, plus each button, plus any text run.
  const blocks = [...panel.children].filter(visible).map((e) => ({
    tag: e.tagName.toLowerCase(), cls: e.className, id: e.id || null,
    text: (e.innerText || "").replace(/\s+/g, " ").trim(),
    h: +e.getBoundingClientRect().height.toFixed(1),
  }));
  const buttons = [...panel.querySelectorAll("button")].filter(visible)
    .map((b) => ({ id: b.id, text: b.innerText.replace(/\s+/g, " ").trim(),
      cls: b.className, h: +b.getBoundingClientRect().height.toFixed(1) }));
  // Is a LETTER GRADE anywhere on the default face?
  const gradeNodes = [...panel.querySelectorAll("*")].filter((e) =>
    e.id === "recap-letter" || e.id === "recap-medal" || e.id === "recap-score"
    || e.className?.toString?.().includes("vmedal"));
  return {
    panelH: +pr.height.toFixed(1), viewportH: innerHeight,
    fitsViewport: pr.bottom <= innerHeight + 1 && pr.top >= -1,
    panelScrolls: panel.scrollHeight > panel.clientHeight + 1,
    blocks, buttons,
    gradeNodesPresent: gradeNodes.length,
    gradeNodeIds: gradeNodes.map((e) => e.id || e.className),
    // The drilldown behind TAB
    tabSheetVisible: getComputedStyle(document.getElementById("recap-tab")).display !== "none"
      && recap.classList.contains("tabbed"),
    title: document.getElementById("recap-title").innerText.trim(),
    sub: document.getElementById("recap-sub").innerText.trim(),
    line: document.getElementById("recap-line").innerText.trim(),
    death: document.getElementById("recap-death").innerText.replace(/\s+/g, " ").trim(),
    ladder: document.getElementById("recap-ladder").innerText.replace(/\s+/g, " ").trim(),
    hint: panel.querySelector(".rhint")?.innerText.replace(/\s+/g, " ").trim(),
  };
});
let cdp = await page.context().newCDPSession(page);
writeFileSync(`${OUT}/verdict-face.png`,
  Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

// HOLD TAB — the drilldown.
await page.keyboard.down("Tab");
await page.waitForTimeout(1500);
out.tabbed = await page.evaluate(() => {
  const t = document.getElementById("recap-tab");
  const vis = getComputedStyle(t).display !== "none";
  const parts = [...t.querySelectorAll("#recap-parts .vpart")].map((p) => ({
    key: p.querySelector(".pk")?.innerText.trim(),
    detail: p.querySelector(".pd")?.innerText.replace(/\s+/g, " ").trim(),
    clipped: (() => { const d = p.querySelector(".pd"); return d ? d.scrollWidth > d.clientWidth + 1 : null; })(),
  }));
  return { visible: vis, parts, basis: document.getElementById("recap-basis").innerText.trim(),
    letterOnSheet: !!t.querySelector("#recap-letter, .vmedal") };
});
cdp = await page.context().newCDPSession(page);
writeFileSync(`${OUT}/verdict-tab.png`,
  Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
await page.keyboard.up("Tab");

// Is a "Mordecai" aside anywhere on this screen, on this build?
out.mordecai = await page.evaluate(() => {
  const recap = document.getElementById("recap");
  const hits = [...recap.querySelectorAll("*")].filter((e) =>
    (e.childElementCount === 0) && /mordecai/i.test(e.textContent || ""));
  return { count: hits.length, texts: hits.map((e) => e.textContent.trim().slice(0, 120)) };
});

writeFileSync(`${OUT}/verdict.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await page.close();
await browser.close();
