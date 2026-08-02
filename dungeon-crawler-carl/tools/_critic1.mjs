// Round-1 acceptance critique captures. Settled frames (animations forced to
// their end) so composition is judgeable, plus the standings/career surfaces.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "tools/_critic1";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5430/iso.html";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });

await page.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "CRITICCRAWLER1");
  localStorage.setItem("dcc:consent:v1", "no");
  localStorage.setItem("dcc:name:v1", "Carl");
});

async function settle() {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) { try { a.finish(); } catch { /* infinite */ } }
  });
  await page.waitForTimeout(200);
}

async function shot(name) {
  await settle();
  await page.screenshot({ timeout: 300000, path: `${OUT}/${name}.png` });
  console.log("saved", name);
}

async function boot(url) {
  await page.goto(url, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 })
    .catch(() => console.error("WARN assets never settled"));
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
}

async function die() {
  await page.evaluate(() => {
    const s = window.__dcc.state;
    s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead";
  });
  await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 40000 });
}

// ---- 1. shallow death
await boot(`${BASE}?debug=1&test&floor=1&level=1&seed=7`);
await die();
await shot("A-verdict-shallow");

// TAB held
await page.keyboard.down("Tab");
await page.waitForTimeout(400);
await shot("B-verdict-tab");
await page.keyboard.up("Tab");

// ---- 2. deep death
await boot(`${BASE}?debug=1&test&floor=12&level=20&abilities=all&gold=800&seed=31`);
await die();
await shot("C-verdict-deep");
await page.keyboard.down("Tab");
await page.waitForTimeout(400);
await shot("D-verdict-deep-tab");
await page.keyboard.up("Tab");

// ---- 3. a win
await boot(`${BASE}?debug=1&test&floor=18&level=30&abilities=all&gold=2000&seed=7`);
await page.evaluate(() => {
  const s = window.__dcc.state;
  s.status = "won";
});
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 40000 })
  .catch(() => console.error("WARN no recap on win"));
await shot("E-verdict-win");

// ---- 4. seal states, driven by hand on the live verdict
const sealStates = [
  ["F-seal-claimed", "vseal claimed", "<div class=\"vk\">SUBMITTED</div><div class=\"vw\">CLAIMED</div>"],
];
for (const [name, cls] of sealStates) {
  const ok = await page.evaluate((c) => {
    const el = document.getElementById("recap-seal");
    if (!el) return false;
    el.className = c;
    return true;
  }, cls);
  if (ok) await shot(name);
}

// dump the verdict DOM text for reading
const verdictText = await page.evaluate(() => document.getElementById("recap")?.innerText ?? "NONE");
console.log("=== VERDICT TEXT ===\n" + verdictText + "\n=== END ===");

// ---- 5. standings
await page.evaluate(() => { document.getElementById("recap").style.display = "none"; });
await page.evaluate(() => document.getElementById("recap-standings")?.click());
await page.waitForTimeout(2500);
await shot("G-standings-default");
const ladderText = await page.evaluate(() => document.getElementById("ladder")?.innerText ?? "NONE");
console.log("=== STANDINGS TEXT ===\n" + ladderText + "\n=== END ===");

for (const tab of ["alltime", "bands", "rivals"]) {
  const clicked = await page.evaluate((t) => {
    const el = document.querySelector(`#ladder [data-tab="${t}"]`);
    if (el) { el.click(); return true; }
    return false;
  }, tab);
  if (!clicked) { console.log("no tab", tab); continue; }
  await page.waitForTimeout(2000);
  await shot(`H-standings-${tab}`);
}

await browser.close();
console.log("done");
