// Geometry + affordance probe on a fast test-chamber verdict.
import { chromium } from "playwright";
const API = "http://localhost:5441";
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on("pageerror", e => console.error("PAGE ERROR:", e.message));
await p.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "C2-GEO-TOKEN-0009");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:consent:v1", "public");
});
await p.goto(`http://localhost:5430/iso.html?test&floor=12&level=20&abilities=all&gold=800&seed=42&api=${encodeURIComponent(API)}&noassets&debug=1&q=low`, { waitUntil: "load", timeout: 120000 });
await p.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await p.waitForTimeout(3000);
await p.evaluate(() => { const s = window.__dcc.state; s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead"; });
await p.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 });
await p.waitForTimeout(3000);
await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish() } catch { } } });

console.log("=== MEDAL CAPTION OVERFLOW ===");
console.log(await p.evaluate(() => {
  const panel = document.querySelector("#recap .panel").getBoundingClientRect();
  const basis = document.getElementById("recap-basis").getBoundingClientRect();
  const medal = document.getElementById("recap-medal").getBoundingClientRect();
  const cs = getComputedStyle(document.getElementById("recap-basis"));
  const padL = parseFloat(getComputedStyle(document.querySelector("#recap .panel")).paddingLeft);
  return JSON.stringify({
    panelLeft: Math.round(panel.left), panelContentLeft: Math.round(panel.left + padL),
    basisLeft: Math.round(basis.left), basisRight: Math.round(basis.right),
    basisWidth: Math.round(basis.width), basisLines: Math.round(basis.height / parseFloat(cs.lineHeight)),
    medalLeft: Math.round(medal.left), medalWidth: Math.round(medal.width),
    overflowsPanelPadding: Math.round(panel.left + padL - basis.left),
    text: document.getElementById("recap-basis").textContent,
  }, null, 1);
}));

console.log("=== SHOW THE MATH drawer ===");
await p.evaluate(() => document.getElementById("recap-earned").click());
await p.waitForTimeout(800);
console.log(await p.evaluate(() => JSON.stringify({
  open: getComputedStyle(document.getElementById("recap-earned-detail")).display !== "none",
  detail: document.getElementById("recap-earned-detail").innerText,
}, null, 1)));

console.log("=== DEAD SPACE in the default state ===");
await p.evaluate(() => document.getElementById("recap-earned").click());
await p.waitForTimeout(400);
console.log(await p.evaluate(() => {
  const panel = document.querySelector("#recap .panel").getBoundingClientRect();
  const seal = document.getElementById("recap-seal").getBoundingClientRect();
  const btns = document.querySelector("#recap .rbtns")?.getBoundingClientRect()
    ?? document.getElementById("recap-again").getBoundingClientRect();
  return JSON.stringify({
    panel: [Math.round(panel.width), Math.round(panel.height)],
    sealBottom: Math.round(seal.bottom), buttonsTop: Math.round(btns.top),
    verticalGapPx: Math.round(btns.top - seal.bottom),
  }, null, 1);
}));

console.log("=== does the verdict offer the film? ===");
console.log(await p.evaluate(() => JSON.stringify(
  [...document.querySelectorAll("#recap button")].map(b => b.innerText.replace(/\n/g, " / ")), null, 1)));

await p.screenshot({ path: "tools/_c2/G1-testchamber-verdict.png", timeout: 300000 });
await b.close();
