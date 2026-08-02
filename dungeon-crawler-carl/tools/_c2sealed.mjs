// MY capture of the earned SEALED verdict + the ten seconds after it.
// No state poking anywhere: the crawler signs the daily, walks in, never
// swings, and the collapse clock kills them in sim. Small viewport while the
// clock runs (fill rate is what dilates sim time under SwiftShader), then
// 1600x900 for every photograph.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const OUT = "tools/_c2";
const API = "http://localhost:5441";
mkdirSync(OUT, { recursive: true });
const log = [];
const rec = (k, v) => { log.push(`\n===== ${k} =====\n${v}`); console.log("---", k, "\n" + v); };

const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const p = await b.newPage({ viewport: { width: 520, height: 340 }, deviceScaleFactor: 1 });
p.on("pageerror", e => console.error("PAGE ERROR:", e.message));
await p.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "C2-SEAL-TOKEN-0042");
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
rec("front door", await p.evaluate(() => JSON.stringify({ seed: window.__dcc.state.seed, runEvent: window.__dcc.runEvent }, null, 1)));

const t0 = Date.now();
while (Date.now() - t0 < 22 * 60_000) {
  await p.waitForTimeout(4000);
  const st = await p.evaluate(() => ({ s: window.__dcc.state.status, hp: Math.round(window.__dcc.state.players[0].hp), e: Math.round(window.__dcc.state.elapsed) }));
  if (Math.round((Date.now() - t0) / 1000) % 20 < 5) console.log(Math.round((Date.now() - t0) / 1000) + "s wall", JSON.stringify(st));
  if (st.s !== "playing") break;
}
rec("death", await p.evaluate(() => JSON.stringify({ status: window.__dcc.state.status, floor: window.__dcc.state.floor, elapsed: Math.round(window.__dcc.state.elapsed) }, null, 1)));
await p.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 90000 });
await p.setViewportSize({ width: 1600, height: 900 });

// ===== THE TEN SECONDS: sample the text cheaply, photograph at the ends ====
const readVerdict = () => p.evaluate(() => {
  const t = id => (document.getElementById(id)?.innerText ?? "(hidden)").replace(/\n+/g, " | ");
  return {
    ladder: t("recap-ladder"), seal: t("recap-seal"), mark: t("recap-mark"),
    banked: t("recap-banked"), earned: t("recap-earned"),
    sealClass: document.getElementById("recap-seal")?.className,
    submitResult: JSON.stringify(window.__dcc.submitResult ?? null),
  };
});
const timeline = [];
const tRecap = Date.now();
for (let i = 0; i < 30; i++) {
  timeline.push(`${String(Date.now() - tRecap).padStart(6)}ms  seal[${(await readVerdict()).sealClass}]  ${(await readVerdict()).seal.slice(0, 110)}`);
  const v = await readVerdict();
  if (/verified|sealed|refused|unproven/i.test(v.sealClass ?? "") && i > 3) break;
  await p.waitForTimeout(700);
}
rec("THE SEAL, as it lands", timeline.join("\n"));

await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish() } catch { } } });
await p.waitForTimeout(400);
const v = await readVerdict();
rec("THE VERDICT, as it reads", Object.entries(v).map(([k, x]) => k.padEnd(13) + ": " + x).join("\n"));
rec("FULL PANEL TEXT", await p.evaluate(() => document.querySelector("#recap .panel").innerText));
rec("panel geometry", await p.evaluate(() => {
  const el = document.querySelector("#recap .panel"), r = el.getBoundingClientRect();
  return JSON.stringify({
    viewport: [innerWidth, innerHeight], panel: [Math.round(r.width), Math.round(r.height)],
    at: [Math.round(r.left), Math.round(r.top)],
    share: +((r.width * r.height) / (innerWidth * innerHeight) * 100).toFixed(1) + "%",
    scrolls: el.scrollHeight > el.clientHeight + 1,
  }, null, 1);
}));
await p.screenshot({ timeout: 300000, path: `${OUT}/S1-verdict-sealed.png` });

await p.keyboard.down("Tab"); await p.waitForTimeout(1500);
await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish() } catch { } } });
await p.screenshot({ timeout: 300000, path: `${OUT}/S2-verdict-tab.png` });
rec("TAB", await p.evaluate(() => document.querySelector("#recap .panel").innerText));
await p.keyboard.up("Tab"); await p.waitForTimeout(600);

await p.evaluate(() => document.querySelector("#recap .earned")?.click());
await p.waitForTimeout(1200);
await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish() } catch { } } });
await p.screenshot({ timeout: 300000, path: `${OUT}/S3-verdict-math.png` });
rec("SHOW THE MATH", await p.evaluate(() => document.querySelector("#recap .earned")?.innerText ?? "(none)"));

await p.evaluate(() => document.getElementById("recap-standings")?.click());
await p.waitForTimeout(3000);
for (const t of ["contracts", "alltime", "bands", "rivals"]) {
  await p.evaluate((tab) => document.querySelector(`[data-lt="${tab}"]`)?.click(), t);
  await p.waitForTimeout(1600);
  await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish() } catch { } } });
  await p.screenshot({ timeout: 300000, path: `${OUT}/S4-standings-${t}.png` });
  rec("STANDINGS " + t, await p.evaluate(() => document.querySelector("#ladder .set-frame")?.innerText ?? "(none)"));
}
await p.evaluate(() => document.getElementById("ladder-close")?.click());
await p.waitForTimeout(400);
await p.evaluate(() => document.getElementById("m-careerset")?.click());
await p.waitForTimeout(3000);
await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish() } catch { } } });
await p.screenshot({ timeout: 300000, path: `${OUT}/S5-career.png` });
rec("CAREER", await p.evaluate(() => document.getElementById("career")?.innerText ?? "(none)"));

writeFileSync(`${OUT}/sealed-dump.txt`, log.join("\n"));
await b.close();
console.log("\nwrote", OUT + "/S*");
