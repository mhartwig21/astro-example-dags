// VERIFY-ONLY probe for the verdict reveal. A SwiftShader screenshot takes
// 12-21s of wall time, which is ten times the length of the cascade - so a
// screenshot series cannot prove or disprove motion. This drives the Web
// Animations API directly: it pauses every animation on #recap and steps
// currentTime to fixed marks, so each capture is the frame that WAS staged.
//   node tools/_reveal_probe.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "tools/_shots";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5430/iso.html";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "SHOTCRAWLER");
  localStorage.setItem("dcc:consent:v1", "no"); // no consent card over the probe
  localStorage.setItem("dcc:name:v1", "Carl");
});
await page.goto(`${BASE}?debug=1&test&floor=4&level=9&abilities=all`, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 })
  .catch(() => console.error("WARN assets never settled"));
await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });

// Kill the crawler outright, then hold every animation still.
await page.evaluate(() => {
  const s = window.__dcc.state;
  s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead";
});
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 30000 });

const named = await page.evaluate(() => document.getAnimations()
  .filter((a) => a.effect?.target && document.getElementById("recap")?.contains(a.effect.target))
  .map((a) => ({
    name: a.animationName ?? "?",
    on: a.effect.target.className || a.effect.target.id,
    delay: a.effect.getComputedTiming().delay,
    dur: a.effect.getComputedTiming().duration,
  })));
console.log("ANIMATIONS ON #recap:", JSON.stringify(named, null, 1));

for (const t of [0, 200, 450, 700, 1100, 1500, 2000]) {
  await page.evaluate((ms) => {
    for (const a of document.getAnimations()) {
      if (!a.effect?.target || !document.getElementById("recap")?.contains(a.effect.target)) continue;
      a.pause();
      try { a.currentTime = ms; } catch { /* finished */ }
    }
  }, t);
  await page.waitForTimeout(120);
  await page.screenshot({ timeout: 300000, path: `${OUT}/R-${String(t).padStart(4, "0")}ms.png` });
  console.log("saved reveal frame", t);
}

// ...and the seal strike, driven by hand: the block goes CLAIMED -> SEALED.
await page.evaluate(() => {
  const el = document.getElementById("recap-seal");
  el.className = "vseal verified ranked";
  el.innerHTML = '<div class="vk">THE SYSTEM RE-RAN YOUR CRAWL</div>'
    + '<div class="vw">SEALED</div>'
    + '<div class="vl">Every input, replayed on the System\'s own machine. Same dungeon, same damage, '
    + 'same death - and it holds a board position. Rules era 2804176.</div>';
  void el.offsetWidth;
  el.classList.add("strike");
});
for (const t of [80, 260, 900]) {
  await page.evaluate((ms) => {
    for (const a of document.getAnimations()) {
      const el = document.getElementById("recap-seal");
      if (!a.effect?.target || !el?.contains(a.effect.target) && a.effect.target !== el) continue;
      a.pause();
      try { a.currentTime = ms; } catch { /* finished */ }
    }
  }, t);
  await page.waitForTimeout(120);
  await page.screenshot({ timeout: 300000, path: `${OUT}/S-${String(t).padStart(4, "0")}ms.png` });
  console.log("saved seal frame", t);
}
await browser.close();
